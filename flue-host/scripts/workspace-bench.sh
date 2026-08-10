#!/usr/bin/env bash
# workspace-bench.sh — reproducible workspace-FS pilot instrument
# (AGENT_OS_M0.md § M0.6). Orchestrates standard OSS instruments plus our
# git domain workload; M2 runs this identical script on each candidate FS
# (JuiceFS-on-MinIO, SeaweedFS, …) and on local disk as the baseline.
#
# Usage:
#   scripts/workspace-bench.sh <target-dir> [second-mount-dir]
#
#   <target-dir>        directory ON the filesystem under test; everything
#                       the bench writes stays under it (plus the report dir)
#   [second-mount-dir]  optional second mount of the SAME store — enables
#                       the two-mount coherence probes
#
# Stages (each SKIPs cleanly with a reason rather than failing the run
# when its instrument is unavailable; a run counts green when no stage
# FAILs):
#   pjdfstest   POSIX conformance (the instrument JuiceFS cites), pinned
#               ref, subset-selectable; needs root (sudo -n) for full
#               semantics
#   fio         raw I/O profile: 4k random rw + 1M sequential write/read —
#               the two git-relevant shapes; buffered psync (FUSE-safe)
#   git         synthetic deterministic repo → clone (--no-local) → N
#               commits → branch+rebase → gc → fsck → content-hash verify
#   coherence   (two mounts only) write-after-close visibility, delete
#               visibility, recreate staleness — with observed lag seconds
#
# Env knobs (all optional):
#   BENCH_NAME           report label            (default: target basename)
#   BENCH_OUT            report directory        (default: ./workspace-bench-out)
#   BENCH_SEED           deterministic seed      (default: 1)
#   BENCH_REPO_FILES     synthetic repo files    (default: 200)
#   BENCH_REPO_BLOB_MB   binary blob total MB    (default: 8)
#   BENCH_COMMITS        commit-loop length      (default: 20)
#   FIO_RUNTIME_S        per-fio-job seconds     (default: 10)
#   FIO_SKIP=1           skip fio stage
#   PJDFSTEST_SKIP=1     skip pjdfstest stage
#   PJDFSTEST_REF        git ref to pin          (default: master @ clone time,
#                        recorded in the report — pass a tag/sha for strict pins)
#   PJDFSTEST_SUBSET     space-separated tests/ subdirs (default: git-relevant set)
#   COHERENCE_TIMEOUT_S  per-probe visibility timeout (default: 30)
#
# Output: <BENCH_OUT>/<name>-<utc-ts>.json  (schema v:1, stable — consumers
# key on .v) and a matching .md summary. Exit: 0 = no stage FAILed,
# 1 = at least one FAIL, 2 = usage/preflight error.
set -euo pipefail

TARGET_DIR="${1:-}"
MOUNT_B="${2:-}"
[[ -n "$TARGET_DIR" ]] || { echo "usage: workspace-bench.sh <target-dir> [second-mount-dir]" >&2; exit 2; }
mkdir -p "$TARGET_DIR" || { echo "workspace-bench: cannot create $TARGET_DIR" >&2; exit 2; }
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
if [[ -n "$MOUNT_B" ]]; then
  [[ -d "$MOUNT_B" ]] || { echo "workspace-bench: second mount $MOUNT_B is not a directory" >&2; exit 2; }
  MOUNT_B="$(cd "$MOUNT_B" && pwd)"
fi
command -v jq >/dev/null || { echo "workspace-bench: jq is required" >&2; exit 2; }
command -v git >/dev/null || { echo "workspace-bench: git is required" >&2; exit 2; }
command -v python3 >/dev/null || { echo "workspace-bench: python3 is required" >&2; exit 2; }

BENCH_NAME="${BENCH_NAME:-$(basename "$TARGET_DIR")}"
BENCH_OUT="${BENCH_OUT:-./workspace-bench-out}"
BENCH_SEED="${BENCH_SEED:-1}"
BENCH_REPO_FILES="${BENCH_REPO_FILES:-200}"
BENCH_REPO_BLOB_MB="${BENCH_REPO_BLOB_MB:-8}"
BENCH_COMMITS="${BENCH_COMMITS:-20}"
FIO_RUNTIME_S="${FIO_RUNTIME_S:-10}"
PJDFSTEST_SUBSET="${PJDFSTEST_SUBSET:-chmod link mkdir open rename rmdir symlink truncate unlink}"
COHERENCE_TIMEOUT_S="${COHERENCE_TIMEOUT_S:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BENCH_OUT"
BENCH_OUT="$(cd "$BENCH_OUT" && pwd)"
JSON_OUT="$BENCH_OUT/$BENCH_NAME-$STAMP.json"
MD_OUT="$BENCH_OUT/$BENCH_NAME-$STAMP.md"
WORK="$TARGET_DIR/workspace-bench.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Hermetic git for every repo op in this script.
GIT_ENV=(env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null)
GIT_ID=(-c user.name=Bench -c user.email=bench@buzz.invalid -c init.defaultBranch=main -c core.autocrlf=false)

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# ── Stage results accumulate as JSON fragments ──────────────────────────────
STAGE_JSON="{}"
put_stage() { # name json
  STAGE_JSON="$(jq -c --arg k "$1" --argjson v "$2" '. + {($k): $v}' <<<"$STAGE_JSON")"
}

# ── pjdfstest ───────────────────────────────────────────────────────────────
run_pjdfstest() {
  if [[ "${PJDFSTEST_SKIP:-0}" == "1" ]]; then
    put_stage pjdfstest '{"status":"SKIP","reason":"PJDFSTEST_SKIP=1"}'; return
  fi
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/workspace-bench/pjdfstest"
  local ref="${PJDFSTEST_REF:-}"
  if [[ ! -x "$cache/pjdfstest" ]]; then
    if ! command -v autoreconf >/dev/null || ! command -v prove >/dev/null; then
      put_stage pjdfstest '{"status":"SKIP","reason":"autoreconf/prove unavailable to build+run"}'; return
    fi
    echo "workspace-bench: building pjdfstest into $cache …"
    rm -rf "$cache"; mkdir -p "$(dirname "$cache")"
    if ! git clone -q ${ref:+--branch "$ref"} --depth 1 https://github.com/pjd/pjdfstest "$cache"; then
      put_stage pjdfstest '{"status":"SKIP","reason":"clone failed (network or bad PJDFSTEST_REF)"}'; return
    fi
    ( cd "$cache" && autoreconf -ifs >/dev/null 2>&1 && ./configure >/dev/null 2>&1 && make pjdfstest >/dev/null 2>&1 ) \
      || { put_stage pjdfstest '{"status":"SKIP","reason":"build failed"}'; return; }
  fi
  local built_ref
  built_ref="$(git -C "$cache" rev-parse HEAD 2>/dev/null || echo unknown)"
  local scratch="$WORK/pjdfstest"; mkdir -p "$scratch"
  local subset_dirs=() d
  for d in $PJDFSTEST_SUBSET; do [[ -d "$cache/tests/$d" ]] && subset_dirs+=("$cache/tests/$d"); done
  [[ ${#subset_dirs[@]} -gt 0 ]] || { put_stage pjdfstest '{"status":"SKIP","reason":"subset matched no test dirs"}'; return; }
  local runner=(prove -r -Q) sudo_used=false
  if [[ "$(id -u)" != "0" ]]; then
    if sudo -n true 2>/dev/null; then runner=(sudo -n prove -r -Q); sudo_used=true
    else put_stage pjdfstest '{"status":"SKIP","reason":"needs root (sudo -n unavailable)"}'; return; fi
  fi
  local started finished out status
  started=$(now_ms)
  set +e
  out="$(cd "$scratch" && "${runner[@]}" "${subset_dirs[@]}" 2>&1 | tail -5)"
  status=$?
  set -e
  finished=$(now_ms)
  # `prove -Q` summary: "All tests successful." + "Files=N, Tests=M, …" or "Result: FAIL".
  local files tests
  files="$(sed -n 's/.*Files=\([0-9]*\),.*/\1/p' <<<"$out" | tail -1)"
  tests="$(sed -n 's/.*Tests=\([0-9]*\),.*/\1/p' <<<"$out" | tail -1)"
  put_stage pjdfstest "$(jq -cn \
    --arg status "$([[ $status -eq 0 ]] && echo PASS || echo FAIL)" \
    --arg ref "$built_ref" --arg files "${files:-0}" --arg tests "${tests:-0}" \
    --arg sudo "$sudo_used" --arg subset "$PJDFSTEST_SUBSET" \
    --argjson ms $((finished - started)) --arg tail "$out" \
    '{status:$status, ref:$ref, files:($files|tonumber), tests:($tests|tonumber),
      sudo:($sudo=="true"), subset:$subset, ms:$ms, summary_tail:$tail}')"
}

# ── fio ─────────────────────────────────────────────────────────────────────
run_fio() {
  if [[ "${FIO_SKIP:-0}" == "1" ]]; then
    put_stage fio '{"status":"SKIP","reason":"FIO_SKIP=1"}'; return
  fi
  command -v fio >/dev/null || { put_stage fio '{"status":"SKIP","reason":"fio not installed"}'; return; }
  local dir="$WORK/fio"; mkdir -p "$dir"
  local out="$dir/fio.json" status
  # Buffered psync (FUSE mounts commonly reject O_DIRECT); fsync cadence
  # mimics git's loose-object writes. Two git-relevant shapes, stonewalled.
  set +e
  fio --output-format=json --output="$out" \
    --directory="$dir" --group_reporting=0 --fallocate=none \
    --name=randrw4k  --rw=randrw  --bs=4k --size=64M  --ioengine=psync --fsync=32 \
                     --time_based --runtime="$FIO_RUNTIME_S" \
    --name=seqwrite1m --stonewall --rw=write --bs=1M --size=256M --ioengine=psync --end_fsync=1 \
    --name=seqread1m  --stonewall --rw=read  --bs=1M --size=256M --ioengine=psync \
    >/dev/null 2>&1
  status=$?
  set -e
  if [[ $status -ne 0 || ! -s "$out" ]]; then
    put_stage fio "$(jq -cn --argjson code $status '{status:"FAIL", reason:"fio run failed", code:$code}')"
    return
  fi
  put_stage fio "$(jq -c '{
    status: "PASS",
    version: .["fio version"],
    jobs: [ .jobs[] | {
      name: .jobname,
      read:  { iops: (.read.iops|round),  bw_mbps: ((.read.bw  / 1024)|round) },
      write: { iops: (.write.iops|round), bw_mbps: ((.write.bw / 1024)|round) },
      fsync_p99_us: (((.sync.lat_ns.percentile["99.000000"] // 0) / 1000) | round)
    } ]
  }' "$out")"
}

# ── git domain workload ─────────────────────────────────────────────────────
gen_tree() { # dir  — deterministic synthetic tree from BENCH_SEED
  python3 - "$1" "$BENCH_SEED" "$BENCH_REPO_FILES" "$BENCH_REPO_BLOB_MB" <<'PY'
import hashlib, os, sys
root, seed, files, blob_mb = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def chain(tag, n):  # n hash-blocks of deterministic, incompressible bytes
    h = hashlib.sha256(f"{seed}:{tag}".encode()).digest()
    out = bytearray()
    for _ in range(n):
        out += h
        h = hashlib.sha256(h).digest()
    return bytes(out)
def hexlines(tag, n):  # n lines of deterministic hex — text, git-mergeable
    h = hashlib.sha256(f"{seed}:{tag}".encode()).hexdigest()
    lines = []
    for _ in range(n):
        lines.append(h)
        h = hashlib.sha256(h.encode()).hexdigest()
    return ("\n".join(lines) + "\n").encode()
for i in range(files):
    d = os.path.join(root, f"src/mod{i % 20}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"file{i}.txt"), "wb") as f:
        f.write(hexlines(f"text{i}", 64))  # ~4 KiB each
blob_bytes = blob_mb * 1024 * 1024
per = blob_bytes // 4
os.makedirs(os.path.join(root, "assets"), exist_ok=True)
for b in range(4):
    with open(os.path.join(root, f"assets/blob{b}.bin"), "wb") as f:
        f.write(chain(f"blob{b}", per // 32))
PY
}

mutate_tree() { # dir round lo hi — deterministic edit of files in [lo, hi)
  # Main-line rounds and feature-branch rounds get DISJOINT ranges so the
  # rebase stage exercises history rewriting, not conflict resolution.
  python3 - "$1" "$2" "$3" "$4" "$BENCH_SEED" <<'PY'
import hashlib, os, sys
root, rnd, lo, hi, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
span = max(hi - lo, 1)
for k in range(10):
    i = lo + (rnd * 17 + k * 13) % span
    p = os.path.join(root, f"src/mod{i % 20}", f"file{i}.txt")
    with open(p, "ab") as f:
        f.write(hashlib.sha256(f"{seed}:{rnd}:{i}".encode()).hexdigest().encode() + b"\n")
PY
}

tree_hash() { # repo-dir → content hash of the tracked worktree
  ( cd "$1" && git ls-files -z | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}

run_git_stage() {
  local base="$WORK/git"; mkdir -p "$base"
  local timings="{}" t0 t1
  phase() { timings="$(jq -c --arg k "$1" --argjson v "$2" '. + {($k): $v}' <<<"$timings")"; }

  t0=$(now_ms)
  local src="$base/source"
  mkdir -p "$src"
  gen_tree "$src"
  "${GIT_ENV[@]}" git -C "$src" "${GIT_ID[@]}" init -q
  "${GIT_ENV[@]}" git -C "$src" "${GIT_ID[@]}" add -A
  "${GIT_ENV[@]}" git -C "$src" "${GIT_ID[@]}" commit -q -m "seed $BENCH_SEED"
  t1=$(now_ms); phase init_commit $((t1 - t0))

  t0=$(now_ms)
  "${GIT_ENV[@]}" git "${GIT_ID[@]}" clone -q --no-local "$src" "$base/clone" 2>/dev/null
  t1=$(now_ms); phase clone $((t1 - t0))

  local repo="$base/clone" round half=$((BENCH_REPO_FILES / 2))
  t0=$(now_ms)
  for round in $(seq 1 "$BENCH_COMMITS"); do
    mutate_tree "$repo" "$round" 0 "$half"
    "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" add -A
    "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" commit -q -m "round $round"
  done
  t1=$(now_ms); phase commits $((t1 - t0))

  t0=$(now_ms)
  "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" switch -q -c feature "HEAD~$((BENCH_COMMITS / 2))"
  for round in $(seq $((BENCH_COMMITS + 1)) $((BENCH_COMMITS + 5))); do
    mutate_tree "$repo" "$round" "$half" "$BENCH_REPO_FILES"
    "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" add -A
    "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" commit -q -m "feature $round"
  done
  "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" rebase -q main
  "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" switch -q main
  "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" merge -q --ff-only feature
  t1=$(now_ms); phase branch_rebase $((t1 - t0))

  t0=$(now_ms)
  "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" gc -q
  t1=$(now_ms); phase gc $((t1 - t0))

  local fsck_ok=true
  t0=$(now_ms)
  "${GIT_ENV[@]}" git -C "$repo" "${GIT_ID[@]}" fsck --full --strict --no-dangling >/dev/null 2>&1 || fsck_ok=false
  t1=$(now_ms); phase fsck $((t1 - t0))

  t0=$(now_ms)
  "${GIT_ENV[@]}" git "${GIT_ID[@]}" clone -q --no-local "$repo" "$base/verify" 2>/dev/null
  local hash_a hash_b hash_match=true
  hash_a="$(tree_hash "$repo")"
  hash_b="$(tree_hash "$base/verify")"
  [[ "$hash_a" == "$hash_b" ]] || hash_match=false
  local dirty
  dirty="$("${GIT_ENV[@]}" git -C "$repo" status --porcelain | wc -l | tr -d ' ')"
  t1=$(now_ms); phase verify $((t1 - t0))

  local status=PASS
  [[ "$fsck_ok" == true && "$hash_match" == true && "$dirty" == "0" ]] || status=FAIL
  put_stage git "$(jq -cn \
    --arg status "$status" --argjson timings "$timings" \
    --arg fsck "$fsck_ok" --arg hash "$hash_match" --arg dirty "$dirty" \
    --arg commits "$BENCH_COMMITS" --arg files "$BENCH_REPO_FILES" --arg blob_mb "$BENCH_REPO_BLOB_MB" --arg seed "$BENCH_SEED" \
    '{status:$status, timings_ms:$timings, fsck_ok:($fsck=="true"), hash_match:($hash=="true"),
      dirty_paths:($dirty|tonumber), config:{commits:($commits|tonumber), files:($files|tonumber),
      blob_mb:($blob_mb|tonumber), seed:$seed}}')"
}

# ── two-mount coherence ─────────────────────────────────────────────────────
wait_for() { # timeout_s predicate-cmd... → echoes observed lag ms, rc 1 on timeout
  local deadline=$((($(now_ms)) + $1 * 1000)) start rc
  start=$(now_ms); shift
  while true; do
    if "$@" >/dev/null 2>&1; then echo $((($(now_ms)) - start)); return 0; fi
    [[ $(now_ms) -lt $deadline ]] || { echo -1; return 1; }
    sleep 0.2
  done
}

run_coherence() {
  if [[ -z "$MOUNT_B" ]]; then
    put_stage coherence '{"status":"SKIP","reason":"no second mount supplied"}'; return
  fi
  local rel="workspace-bench-coherence.$$.txt"
  local a="$TARGET_DIR/$rel" b="$MOUNT_B/$rel"
  local nonce1="coherence-$RANDOM-$RANDOM" nonce2="recreate-$RANDOM-$RANDOM"
  local visible_ms delete_ms recreate_ms status=PASS

  printf '%s\n' "$nonce1" > "$a"; sync "$a" 2>/dev/null || sync
  visible_ms="$(wait_for "$COHERENCE_TIMEOUT_S" grep -q "$nonce1" "$b")" || status=FAIL

  rm -f "$a"
  delete_ms="$(wait_for "$COHERENCE_TIMEOUT_S" test ! -e "$b")" || status=FAIL

  printf '%s\n' "$nonce2" > "$a"; sync "$a" 2>/dev/null || sync
  recreate_ms="$(wait_for "$COHERENCE_TIMEOUT_S" grep -q "$nonce2" "$b")" || status=FAIL
  rm -f "$a"

  put_stage coherence "$(jq -cn --arg status "$status" \
    --argjson visible "$visible_ms" --argjson del "$delete_ms" --argjson recreate "$recreate_ms" \
    '{status:$status, write_visible_ms:$visible, delete_visible_ms:$del, recreate_visible_ms:$recreate}')"
}

# ── run all stages ──────────────────────────────────────────────────────────
echo "workspace-bench: target=$TARGET_DIR name=$BENCH_NAME out=$JSON_OUT"
FS_INFO="$(df -PT "$TARGET_DIR" 2>/dev/null | awk 'NR==2 {print $2" "$1}' || echo unknown)"
run_pjdfstest
run_fio
run_git_stage
run_coherence

OVERALL="$(jq -r '[.[] | select(.status == "FAIL")] | length' <<<"$STAGE_JSON")"
jq -n \
  --arg name "$BENCH_NAME" --arg target "$TARGET_DIR" --arg mount_b "${MOUNT_B:-}" \
  --arg host "$(hostname)" --arg fs "$FS_INFO" --arg ts "$STAMP" \
  --argjson stages "$STAGE_JSON" \
  --arg overall "$([[ "$OVERALL" == "0" ]] && echo PASS || echo FAIL)" \
  '{v:1, name:$name, host:$host, target:$target, second_mount:(if $mount_b == "" then null else $mount_b end),
    fs:$fs, utc:$ts, overall:$overall, stages:$stages}' > "$JSON_OUT"

# ── markdown summary ────────────────────────────────────────────────────────
{
  echo "# workspace-bench: $BENCH_NAME ($STAMP)"
  echo
  echo "- host: \`$(hostname)\` · fs: \`$FS_INFO\` · target: \`$TARGET_DIR\`"
  [[ -n "$MOUNT_B" ]] && echo "- second mount: \`$MOUNT_B\`"
  echo "- overall: **$(jq -r .overall "$JSON_OUT")**"
  echo
  echo "| stage | status | key figures |"
  echo "|---|---|---|"
  jq -r '
    def figs(k; v):
      if k == "git" and v.status == "PASS" then
        "clone \(v.timings_ms.clone)ms · \(v.config.commits) commits \(v.timings_ms.commits)ms · rebase \(v.timings_ms.branch_rebase)ms · gc \(v.timings_ms.gc)ms · fsck \(v.timings_ms.fsck)ms · hash \(if v.hash_match then "match" else "MISMATCH" end)"
      elif k == "fio" and v.status == "PASS" then
        (v.jobs | map("\(.name) r:\(.read.iops)iops/\(.read.bw_mbps)MBps w:\(.write.iops)iops/\(.write.bw_mbps)MBps") | join(" · "))
      elif k == "pjdfstest" and v.status == "PASS" then
        "\(v.tests) tests / \(v.files) files (\(v.ms)ms) @ \(v.ref[0:8])"
      elif k == "coherence" and v.status != "SKIP" then
        "visible \(v.write_visible_ms)ms · delete \(v.delete_visible_ms)ms · recreate \(v.recreate_visible_ms)ms"
      else
        (v.reason // "-")
      end;
    .stages | to_entries[] | "| \(.key) | \(.value.status) | \(figs(.key; .value)) |"
  ' "$JSON_OUT"
} > "$MD_OUT"

cat "$MD_OUT"
echo
echo "workspace-bench: JSON report at $JSON_OUT"
[[ "$OVERALL" == "0" ]] || exit 1
