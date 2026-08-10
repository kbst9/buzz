# M2 workspace pilot — JuiceFS-on-MinIO vs SeaweedFS

**Date:** 2026-08-10 · **Host:** gradient (single node, NVMe, 64-core) ·
**Instrument:** `flue-host/scripts/workspace-bench.sh` (M0.6), pjdfstest
pinned at `85a8aea9`.

Read-only pilot — **no prod mutation**. All three targets benched on the
same NVMe so the deltas are FS-overhead, not hardware. Raw reports:
[juicefs](juicefs-20260810T082935Z.md),
[seaweedfs](seaweedfs-20260810T083117Z.md),
[local baseline](local-baseline-20260809T224755Z.md).

## Setup (both isolated from prod)

- **JuiceFS-on-MinIO** 1.4.1: object store = a **throwaway MinIO** container
  on `127.0.0.1:9100` (NOT prod MinIO); metadata = a **throwaway Redis** on
  `:6400` (NOT prod Redis — JuiceFS needs a concurrent-capable meta engine;
  SQLite is single-mount). Two FUSE mounts share the Redis meta.
- **SeaweedFS** 4.41: self-contained `weed server -filer` (master + volume +
  filer), two `weed mount` of the same filer path.
- Both need `user_allow_other` in `/etc/fuse.conf` + `allow_other` so
  root-run pjdfstest can enter the mount (added on gradient; low-risk on a
  single-tenant box).

## Results

| Dimension | Local (ref) | JuiceFS-on-MinIO | SeaweedFS | Edge |
|---|--:|--:|--:|---|
| fio 4k randrw (read IOPS) | 12807 | 479 | **879** | SeaweedFS ~1.8× |
| fio 4k randrw (write IOPS) | 12812 | 485 | **879** | SeaweedFS ~1.8× |
| fio seq write (MB/s) | 3160 | **1391** | 1384 | tie |
| fio seq read (MB/s) | 6400 | **2510** | 2065 | JuiceFS |
| git clone (ms) | 333 | 1205 | **837** | SeaweedFS |
| git 20 commits (ms) | 903 | **2616** | 2805 | ~tie |
| git rebase (ms) | 207 | **2017** | 2077 | tie |
| git gc (ms) | 125 | **660** | 967 | JuiceFS |
| git fsck (ms) | 59 | **80** | 91 | tie |
| git worktree hash-match | ✓ | ✓ | ✓ | **both correct** |
| coherence: write-visible (ms) | 10 | 14 | **11** | tie |
| coherence: **delete-visible (ms)** | 9 | **1062** | **10** | **SeaweedFS ~100×** |
| coherence: recreate-visible (ms) | 10 | 11 | **10** | tie |
| pjdfstest (6762 run) | 6791 pass | **4 files fail** | **1 file fails** | SeaweedFS |
| external deps | — | MinIO + Redis | none (self-contained) | SeaweedFS |

pjdfstest failing files (POSIX edge cases; both run all 6762 assertions):

- **JuiceFS**: `link/00.t` (15), `link/03.t` (3), `rename/23.t` (5),
  `unlink/14.t` (1) — hard-link semantics are the notable gap.
- **SeaweedFS**: `rename/24.t` (2) — a single rename edge case.

## Projection trial (bind-mount into a scratch container)

The M3 model — an FS-backed workspace bind-mounted into a container — works
on **both**, with two hard requirements learned here:

1. **UID alignment**: a container running as root writes root-owned files
   into the shared workspace that the host user cannot manage or delete, and
   git reports "dubious ownership". Run the container as the host UID
   (`--user $(id -u):$(id -g)`); then git commits succeed and files stay
   host-owned and host-cleanable (verified on both FS).
2. **Git preinstalled in the image**: a non-root container can't `apk add`,
   so the workspace image must ship git (`alpine/git` worked). This is a
   base-image note for M3's "vendored sandbox-sdk image."

## Reading

- **Both are correct for git** — the core agent workload — and both run
  ~3–10× slower than local NVMe (expected; every metadata op is a network
  round-trip). Neither's latency is disqualifying for interactive agent
  work; sequential throughput (1.4–2.5 GB/s) is ample for clones/builds.
- **SeaweedFS is the stronger technical fit on this single-node topology**:
  ~1.8× the small-random IOPS, faster clone, **~100× better cross-mount
  delete-coherence** (JuiceFS lags ~1 s to propagate a delete between
  mounts — a real hazard for shared/projected workspaces), cleaner POSIX
  (1 vs 4 failing files; JuiceFS's hard-link gaps can bite tooling), and
  **no external MinIO/Redis dependency** (one fewer succession risk).
- **JuiceFS-on-MinIO's advantage is topological, not performance**: it
  reuses an object store the deployment already runs. That appeal is
  entirely contingent on **park point 4 (MinIO succession)** — if MinIO is
  frozen/forked/consolidated, JuiceFS-on-MinIO inherits that decision plus a
  new Redis dependency and the delete-coherence lag.

## Recommendation direction (defers to park point 4 — Kevin's)

For a *new* workspace substrate, the pilot points at **SeaweedFS**:
self-contained, better small-IO + coherence + POSIX, no MinIO/Redis
coupling. JuiceFS-on-MinIO only wins if the strategic goal is to keep
everything on the existing MinIO — which is exactly what **park point 4**
decides. So this pilot **informs** park point 4; it does not pre-empt it.
No workspace substrate reaches prod until that decision is made.
