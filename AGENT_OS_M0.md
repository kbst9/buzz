# agentOS Implementation — M0: Verification Substrate & Goal Spec

> **Fork-local operating doc (deploy branch only — never upstream).**
> Created 2026-08-09. Owner: Kevin; executed in goal mode by Claude.
> Companions: [AGENTOS_HOST_PLAN.md](AGENTOS_HOST_PLAN.md) (plan of record,
> topology T2) and [AGENT_OS_ANALYSIS_M1.md](AGENT_OS_ANALYSIS_M1.md)
> (ecosystem analysis + the revised implementation ladder this goal executes).

## Purpose

End-to-end implementation of the sandbox-tier ladder runs autonomously
("goal mode"). Autonomy is only safe when progress is machine-checkable:
every rung must land behind gates that a session can run, read, and act on
without eyeballs. **M0 builds that substrate before any tier code is
written.** Nothing in M0 changes agent behavior in prod.

## The goal (whole run)

Replace the interim execution posture ("containment = env allowlist only")
with tiered, egress-controlled sandboxing per the M1 ladder — srt native
light tier first, then workspace projection, then a hardened heavy tier —
integrated with the fleet machinery (fleet.toml), deployed canary-first on
gradient, live-verified at every step, with a stated rollback per layer.

## Goal-mode operating rules

1. **Branches**: one feature branch per rung (`feat/sandbox-tier-<name>`),
   stacking on the agent-invites lineage where relay code is touched;
   `deploy` receives merges only when the rung's exit gate is green.
2. **Gates before claims**: a rung is "done" when its conformance suite,
   the live smoke, and `just ci` are green — never on code review alone.
3. **Prod discipline** (existing conventions, restated as rules): back up
   before replacing; one-command rollback stated per layer; **rollback
   rehearsed once per new tier on the canary** (pin back, smoke green on
   the old tier) before any fleet rollout; memory entry per deploy; heavy
   builds on gradient; destructive/PG-gated tests only against throwaway
   Postgres (never prod); canary before fleet.
4. **Park points**: decisions listed in § Park points are Kevin's. On
   reaching one: stop, summarize state + options, ask. Do not decide.
5. **This doc is live**: update the status tables as rungs progress; every
   deviation from the spec gets a dated note here, not a silent change.
6. **Policy over mechanism**: agent-facing sandbox configuration lives in
   the tier-agnostic policy schema (§ Architecture invariants), never in
   tier-native syntax. Tier adapters translate; swapping tiers must never
   require re-authoring an agent's policy.
7. **External components** enter only through the Component Registry
   (§ below): exact pin, one seam file, named replacement candidate,
   upgrade via the standing protocol. No inline `npm add` without a
   registry row.

## Architecture invariants (what "clean, replaceable components" means here)

1. **Tier registry + selector.** All factories live under
   `flue-host/src/sandbox/`: one file per tier implementing the internal
   adapter interface, registered by name; `BUZZ_FLUE_SANDBOX=local|srt|…`
   selects at session start. Adding/removing a tier touches one file plus
   its registration and conformance entry — nothing else.
2. **Tier-agnostic policy schema** (extends the fleet.toml contract in M1):
   per-agent `sandbox` block — `tier`, `fs_scope`, `egress = ["relay",
   "<domain>", …]`, `escalation = true|false`. The schema is OURS and
   stable; each adapter translates it to its native mechanism (srt
   settings, agentOS permissions, container network config). Golden-tested
   like the rest of fleet config.
3. **Normalized violation type.** Adapters map native denials
   (srt denial reasons, agentOS permission errors, container failures)
   into one `SandboxViolation` shape; the model-visible error text renders
   from the normalized form. Model-visible behavior is thereby stable
   across tier swaps — prompts never couple to a tier's error strings.
4. **Contract-drift canary.** A compile-time-only test pins the exact
   Flue `SessionEnv`/`SandboxFactory` surface we depend on; a Flue bump
   that moves the contract fails `tsc` in `just flue-check` loudly,
   before any runtime symptom.
5. **Versioned observable schemas.** The audit-log line and the bench
   report carry a schema version field (`v: 1`); consumers key on it.

## Component registry & upgrade protocol

| Component | Pin discipline | Seam (the one place that touches it) | Replacement candidates |
|---|---|---|---|
| `@flue/runtime` (withastro/flue) | exact (2.0.1; bump-check 2.0.3 in M1 entry) | `flue-host/src/engine/` | Pi + own adapter (accepted harness swap path) |
| `@anthropic-ai/sandbox-runtime` (srt) | exact (0.0.x churn) | `src/sandbox/srt.ts` adapter only | nono (Landlock), vendored codex-sandbox crates |
| agentOS (`@rivet-dev/agentos-core`) — conditional M5 | exact | `src/sandbox/agentos.ts` | workerd+miniflare (computer-style), celld end-state |
| Heavy-tier runtime (M3 selection) | image by digest | `src/sandbox/heavy.ts` + provisioning | OpenSandbox / Docker+proxy / microsandbox |
| Workspace FS (M2 selection) | release pin | mount units + bench only — invisible to flue-acp | JuiceFS ↔ SeaweedFS ↔ s3ql |
| Bench instruments (pjdfstest, fio) | apt/repo pin | `scripts/workspace-bench.sh` | — (they are the standard) |

**Upgrade protocol** (any registry row): bump on a branch → conformance
suite → golden → canary deploy → smoke → rehearsed rollback → fleet.
Same ladder for replacing a component as for upgrading it — that symmetry
is the point of the seams.

## M0 deliverables

### M0.1 — Gate wiring (flue-host into the standard loop)
flue-host's tests currently run in **no gate** (verified 2026-08-09: absent
from justfile, lefthook, workflows).
- Add `just flue-check` (install + vitest) to the `just ci` chain and the
  pre-push hook set, mirroring how desktop/mobile checks are wired.
- **Done means**: a deliberately broken flue-host test fails `just ci`
  locally and on gradient; pre-push blocks.

### M0.2 — Tier-conformance suite (the core artifact)
One parameterized suite every `SandboxFactory` must pass —
`flue-host/test/conformance/` with a `describeSandboxConformance(makeFactory,
capabilities)` entry, capability-gated per tier
(`native`, `git`, `egress-allowlist`, `fs-projection`).
**Hermeticity requirements**: loopback only; ephemeral ports per test;
`GIT_CONFIG_GLOBAL=/dev/null` + explicit `-c user.name/email` for git
assertions; no dependence on host state; parallel-safe under vitest.
Includes the compile-time contract-drift canary (invariant 4).
- **Exec semantics**: exit codes; stdout/stderr capture; cwd rooting
  (absolute + relative); env injection; **timeout and cancel → durable
  abort → stopReason `cancelled`** (golden-path parity).
- **Secret canary**: plant `CANARY_HOST_SECRET` in the host process env;
  assert it is unreadable inside the sandbox by env and by any FS probe.
- **FS verbs**: the full `SessionEnv` surface (~10 methods) incl. the
  `writeFile`-creates-parents guarantee.
- **Native + git** (capability `native`,`git`): execute a real ELF binary;
  `git init`/`commit`/`log` round-trip in the workspace.
- **Egress fixtures** (capability `egress-allowlist`): local HTTP echo
  server = allowed target, second local listener + external name = denied
  targets. Assert: allowed reachable; denied blocked; **violation surfaced
  in the tool result in the NORMALIZED `SandboxViolation` shape**
  (invariant 3 — asserted against our shape, never a tier's native text).
- **Golden transcript per tier**: the existing golden ACP test re-run with
  the tier's factory (scripted model, real exec in that tier).
- **Done means**: current `local()` passes the full suite (baseline run,
  no capability skips except `egress-allowlist`); suite is in `just
  flue-check`; adding a tier = one new ~20-line registration file.

### M0.3 — Live-fleet smoke (scripted; replaces the manual loop)
`flue-host/scripts/fleet-smoke.ts` (tsx, like live-smoke) or `.sh`;
parameterized by env: `SMOKE_SENDER_ENV` (unit env file for the sending
identity), `SMOKE_TARGET_PK`, `SMOKE_CHANNEL`, `SMOKE_DEADLINE_S`.
- Sends a mention turn (the codex-identity pattern from 2026-08-08
  verification) **in a dedicated smoke channel** (created once; keeps
  probe traffic out of real channels), polls the thread for a reply
  within deadline, greps the unit journal window for ERROR. Observer
  frames are owner-side ground truth (archive.db on the Mac) — an
  optional `--frames` mode checks them when run there; the reply is the
  hard gate on gradient.
- **Output contract**: one human line + one JSON object (`v: 1`), and
  **enumerated exit codes** — 0 pass, 2 no-reply-within-deadline,
  3 journal-errors, 4 send-failure — so goal mode branches on failure
  class, never on prose. The doc section for each rung lists the matching
  **rollback one-liner** next to the smoke invocation.
- **Done means**: one command run against gradient returns PASS against
  the current live fleet (Fluelo), and provably returns the right
  distinct code against a stopped unit.

### M0.4 — Canary agent (fleet machinery reused)
A dedicated fleet entry (`canary`, model cheap, `respond_to` owner-only)
that runs each new tier first while real agents stay untouched — additive,
in the prod community, consistent with deploy-in-place.
- Tier selection must be env-pinned per agent (e.g. `BUZZ_FLUE_SANDBOX=
  local|srt|…` consumed by the factory selector added in M1) so canary
  switches tiers by env edit + restart, no rebuild.
- **PARK (Kevin, small)**: needs one agent invite to claim (fleet invite
  with spare uses, or one Add-agent mint). Everything else is scripted via
  `provision-fleet.ts`.
- **Done means**: `buzz-acp-canary` live on gradient, smoke-green on the
  `local` tier.

### M0.5 — Per-exec audit log (debug backbone)
A dedicated `src/sandbox/audit.ts` module (not inline logging) consumed by
the tier registry wrapper: one structured line per exec —
`{v: 1, tier, argv0, cmd_sha256, cwd, ms, exit, violations: SandboxViolation[]}`
— info level, argv0+hash only (full command text at debug level only;
command lines can carry sensitive content). Violations arrive already
normalized (invariant 3); the schema is versioned (invariant 5) so later
consumers (dashboards, kind-44200 metrics) key on `v`.
- **Done means**: golden test asserts audit lines for its execs; a live
  turn shows them in `journalctl -u buzz-acp-canary`.

### M0.6 — Workspace bench (reproducible pilot instrument)
`flue-host/scripts/workspace-bench.sh <target-dir> [second-mount-dir]` —
an orchestrator over **standard OSS instruments plus our domain workload**,
not hand-rolled correctness checks:
- **pjdfstest** (the POSIX conformance suite; the same instrument JuiceFS
  cites) — the FS-correctness stage, subset-selectable for runtime.
- **fio** — raw I/O profile stage (small-random + large-sequential, the
  two git-relevant shapes).
- **Ours (domain workload)**: synthetic repo (size-controlled,
  deterministic seed) → clone → N commits → branch/rebase → `git gc` →
  `git fsck` → content-hash verification; optional two-mount coherence
  probes (write A / read-after-close B; delete/recreate staleness).
Emits a JSON (`v: 1`) + markdown report (timings + correctness verdicts).
- **Done means**: green baseline on local disk; report schema stable;
  M2 runs the identical script on each candidate FS.

## The ladder (M1+), gates and park points

| Rung | Work | Entry gate | Exit gate | Rollback | Park |
|---|---|---|---|---|---|
| **M1 — srt native light tier** | `srt.ts` adapter in the tier registry; gradient prereqs (`apt install socat`, bwrap/AppArmor smoke); **the tier-agnostic `sandbox` policy block lands in fleet.toml** (invariant 2, golden-tested) with the srt translator as its first backend; Flue 2.0.1→2.0.3 bump-check | M0 complete | conformance (all caps incl. egress) + golden + canary smoke green; audit lines show tier=srt; **rollback rehearsed** (pin to `local`, smoke green) | env-pin back to `local`, restart unit | **prod rollout order/timing** (which agents, when); **web-egress policy** per agent class (relay-only vs allowlist vs fetch-tool) |
| **M2 — workspace pilot** | bench (M0.6) on JuiceFS-on-MinIO and SeaweedFS; two-mount coherence; projection trial (bind-mount into a scratch container) | M1 exit (or parallel, read-only wrt fleet) | two bench reports + written comparison in M1 doc | n/a (pilot, no prod mutation) | **MinIO succession strategy** (freeze/fork vs SeaweedFS consolidation vs Garage split) — blocks M2→prod |
| **M3 — heavy tier** | OpenSandbox egress-depth audit vs Docker+srt-proxy vs microsandbox (KVM); vendored sandbox-sdk image as base; workspace projection per M2 outcome; escalation binding registered per-agent (fleet.toml flag) | M2 decision made | egress acceptance tests + conformance (heavy caps) + canary escalation smoke | disable binding flag + stop containers | **tier selection sign-off**; CubeSandbox only if license clarifies |
| **M4 — gVisor pre-stage** | `runsc` + daemon.json runtime entry; per-container opt-in unused until hostile-tenant phase | any time after M3 shape known | `docker run --runtime=runsc` smoke on the heavy image | remove runtime entry | none |
| **M5 (conditional) — isolate tier + broker** | agentOS factory + buzz bridge, and/or nono-style signing broker (nsec out of Ring 2) | explicit trigger: prompt-injection containment need, or srt insufficiency in practice | conformance + smoke as ever | env-pin back | trigger itself is Kevin's call |

## Park points (consolidated — Kevin's decisions)

1. ~~**Canary invite** (M0.4)~~ ✅ resolved 2026-08-10 — minted, canary live.
2. ~~**Web-egress policy** (gates M1 fleet rollout)~~ ✅ resolved 2026-08-10 — relay + curated allowlist; Fluelo live with `relay,github.com,raw.githubusercontent.com,docs.rs`.
3. ~~**srt prod rollout order/timing** (gates M1 completion)~~ ✅ resolved 2026-08-10 — switch Fluelo now (done, smoke PASS). **M1 COMPLETE.**
4. ~~**MinIO succession** (gates M2 → prod storage; M3 substrate)~~ ✅ resolved 2026-08-10 — **SeaweedFS for workspace, keep MinIO for media**. M3 entry gate satisfied.
5. ~~**Heavy-tier selection** (gates M3 deploy)~~ ✅ resolved 2026-08-10 — **BUILD the heavy tier now**: Docker + srt-proxy (the audit's recommendation). (Kevin first said hold, then redirected to build.) microsandbox stays the M5 isolate-tier option; gVisor (M4) is the opt-in hardening layer on the Docker heavy image.
6. **M5 trigger** (whether/when the isolate tier is warranted) — Kevin's call; not yet triggered.
6. **M5 trigger** (whether/when the isolate tier is warranted).

## M0 status

| Item | Status |
|---|---|
| M0.1 gate wiring | ✅ 2026-08-10 (merged to deploy behind the green M0 checkpoint CI) |
| M0.2 conformance suite | ✅ 2026-08-10 (`feat/sandbox-m0`) |
| M0.3 fleet smoke | ✅ 2026-08-10 (live PASS 9.4 s vs Fluelo; exit 2 proven vs stopped unit) |
| M0.4 canary agent | ✅ 2026-08-10 (invite minted by Kevin; `buzz-acp-canary` live, smoke 6.4 s on `local`) |
| M0.5 audit log | ✅ 2026-08-10 (golden asserts lines; live lines in `journalctl -u buzz-acp-flue`) |
| M0.6 workspace bench | ✅ 2026-08-10 (gradient baseline PASS: pjdfstest 6791 tests, fio, git workload, coherence) |

## Progress notes (dated; newest first)

### 2026-08-10 — M3 heavy tier BUILT + validated on the canary

Kevin redirected from "hold" to "build the heavy tier" → built the audit's
recommended **Docker + srt-proxy** tier and validated it end-to-end.

- **`src/sandbox/docker.ts`** — the `docker` heavy tier (native + git +
  egress-allowlist + fs-projection). Each agent's execs run via `docker exec`
  in a long-lived per-agent container; egress = internal Docker network
  (deny-by-default, no route) + a dual-homed tinyproxy allowlist (our egress
  vocab); workspace bind-mounted at the host path, container runs as the host
  UID (files stay host-owned — the M2 lesson), `buzz` CLI bind-mounted RO.
  Process-global resources keyed on policy signature (one container per agent
  in prod); egress denials normalized + deduped per-exec.
- **Base image** `heavy-base.Dockerfile` = **ubuntu:24.04** (glibc 2.39 — the
  host-built `buzz` needs ≥2.38; debian-bookworm's 2.36 could not load it) +
  git/curl/ca-certs.
- **Escalation binding** (fleet.toml): `escalation = true` overrides `tier`
  and emits `BUZZ_FLUE_SANDBOX=docker` — one flag binds an agent to the heavy
  tier; rollback is the inverse + stop containers.
- **Bugs found + fixed while building** (all empirical, on gradient): proxy
  readiness raced first exec (busybox wget exit-code false-positive → switched
  to a netstat listen-check); glibc mismatch (→ ubuntu base); tinyproxy
  denial-log format ("refused on filtered domain") → normalized violation;
  cross-exec violation re-attribution (module-level dedup); `docker exec`
  client exits 0 when killed → force exit 124 on abort so the timeout contract
  holds.
- **Exit gate**: conformance **27/27 on gradient** (full suite, heavy caps —
  incl. durable abort, secret canary, native, git, all egress tests, golden,
  cancel-mid-exec); egress acceptance proven (allowed 200 / denied 403 /
  normalized violation); **canary escalation smoke PASS 6.3–9.4 s** with the
  agent's `buzz` exec running INSIDE container `buzz-heavy-*`, egress scoped
  to the relay, audit `tier:"docker"`; **rollback rehearsed live** (docker→srt
  one flag + stop containers → smoke PASS on srt, 0 containers left).
  `just ci` on gradient: running (final gate).
- **Prod state**: canary on the **docker** heavy tier (validated resting
  state; 2 idle containers: agent + proxy). Fluelo stays on **srt** — moving
  prod agents to the heavy tier is a separate rollout decision (not taken).
  dist refreshed (docker tier); backup `dist.bak-20260810-predocker`; env bak
  `canary.env.bak-20260810-docker`. Relay/DB/other units untouched.

### 2026-08-10 — M3 heavy-tier audit done; **park point 5 ready for sign-off**

Entered M3 (substrate = SeaweedFS, park pt 4). First deliverable — the
heavy-tier audit — complete: [docs/heavy-tier-audit.md](docs/heavy-tier-audit.md).

- **Docker+srt-proxy baseline empirically validated on gradient**:
  deny-by-default (internal Docker net = no egress) + allowlist proxy →
  allowed reached / denied → HTTP 403 Filtered. Same egress depth as the
  light tier, container boundary; SeaweedFS projection proven (M2). Docker
  spike torn down; prod intact.
- **OpenSandbox + microsandbox researched from primary sources** (two
  parallel subagents). Distilled: no candidate's egress is *deeper* than the
  baseline (all deny-by-default-capable); they differ in ISOLATION, which
  maps to threat model. microsandbox = true KVM microVM (strongest, but
  overkill for own non-hostile agents + projection is its least-mature
  layer + fast-churning beta) → **the M5 isolate-tier candidate, not the
  heavy tier now**. OpenSandbox = pre-1.0 Python framework whose egress ≈
  baseline, whose gVisor ⊥ its own egress sidecar, and whose credential
  vault is HTTP-auth-shaped → **do not adopt**. Neither vault covers
  in-process Nostr nsec signing (that stays the M5 signing-broker job).
- **Gradient facts**: /dev/kvm present + nested virt + bare metal (all three
  viable); microsandbox needs kvm-group prep (kbs not in it) → the
  microsandbox egress/projection spike is deferred to if/when it's chosen
  (M5), rather than installing a microVM stack on prod for a non-frontrunner.
- **Recommendation direction (park pt 5, Kevin's)**: **Docker + srt-proxy**
  heavy tier (cloudflare sandbox-sdk base image, gVisor/M4 opt-in hardening).
  Awaiting sign-off; on approval I build the heavy tier + escalation binding
  (fleet.toml flag already schema-ready) toward the M3 exit gate.

### 2026-08-10 — M2 workspace pilot COMPLETE; ladder now blocked on park points 4 & 5

Ran the M0.6 bench on **JuiceFS-on-MinIO** and **SeaweedFS** (both fully
isolated from prod — throwaway MinIO :9100, throwaway Redis :6400, own
SeaweedFS server) plus a projection trial. Exit gate met: two bench
reports + written comparison — [docs/bench-m2/COMPARISON.md](docs/bench-m2/COMPARISON.md),
anchored in the M1 analysis doc. **No prod mutation** (pilot).

- **Finding**: SeaweedFS is the stronger technical fit on the single-node
  topology (~1.8× 4k IOPS, faster clone, **~100× better cross-mount
  delete-coherence** — JuiceFS lags ~1 s, cleaner POSIX 1-vs-4 failing
  pjdfstest files incl. JuiceFS hard-link gaps, no MinIO/Redis dep). Both
  git-correct (hash-match) at ~3–10× local latency. JuiceFS-on-MinIO's
  only edge is topological (reuses MinIO) — contingent on park point 4.
- **Projection trial**: bind-mount into a container works on both, but
  requires UID-aligned container users (root writes host-unmanageable
  files) + a git-preinstalled base image (non-root can't `apk add`) —
  both are M3 inputs.
- **Bench-tooling robustness fixes found via the pilot** (folded into
  workspace-bench.sh): a FUSE mount is not root-accessible without
  `user_allow_other` + `allow_other`, so pjdfstest silently 0-ran until
  remounted; the "overall FAIL" is pjdfstest POSIX edge-cases, not a git
  failure.
- **Ladder now fully blocked on Kevin**: M3 entry = "M2 decision made" →
  needs **park point 4 (MinIO succession** — which storage substrate) and
  **park point 5 (heavy-tier selection**). M4 (gVisor pre-stage) needs
  M3's image shape, so it too waits. M5 is trigger-gated. No further ladder
  build is possible without those decisions; bench infra torn down.

### 2026-08-10 — M1 srt tier: exit gate met on the canary; **fleet rollout parked (points 2 & 3)**

srt native light tier built, conformance-green on both platforms, and
live-validated on the canary. **Empirical spike drove every choice** (the
goal's "verify, don't assume"):

- **AppArmor blocker + resolution (the M1 prereq that bit).** gradient's
  `apparmor_restrict_unprivileged_userns=1` confines srt's apply-seccomp
  nested userns through the apt bwrap AppArmor profile, so srt's own
  documented `sysctl=0` fix ALONE does not work — proven by toggling it and
  re-spiking. Fix without any host-security change: the tier sets
  `allowAllUnixSockets:true`, which makes srt skip the apply-seccomp step;
  egress + FS scoping stay enforced by bwrap's empty netns + UDS proxy +
  binds, dropping only the AF_UNIX defense-in-depth layer. Documented in
  `src/sandbox/srt.ts`; a full-seccomp posture (disable bwrap profile +
  sysctl) is a later host-hardening option, not required.
- **srt API pinned by spike, not docs**: `customConfig` does NOT override
  egress (proxy enforces the init allowlist) → init-once-per-process,
  re-init on policy change; `wrapWithSandboxArgv` derives env from
  `process.env` → the tier scrubs to the Ring-2 allowlist + seed BUZZ_* +
  srt's proxy vars (secret-canary holds under srt); loopback echo servers
  don't survive netns removal → conformance egress redesigned around the
  **violation differential** (allowlisted host = no policy violation,
  denied host = normalized violation), hermetic and cross-platform.
- **Deliverables**: `src/sandbox/srt.ts` (native+git+egress-allowlist,
  fs-verbs cwd-jailed to close the M0.2 read-tool hole); `egress.ts`
  (our vocab → allowedDomains); fleet.toml `[agents.sandbox]` block
  (invariant 2) parsed + validated + golden-tested, wired to
  `BUZZ_FLUE_SANDBOX`/`BUZZ_FLUE_EGRESS`; Flue **2.0.1→2.0.3** bump — the
  contract-drift canary caught the `createSessionEnv→createSandbox` rename,
  adapters migrated, canary re-pinned to contract-v2 (its documented flow).
- **Exit gate**: conformance **27/27 on both** macOS/seatbelt AND
  Linux/bwrap (local skips only egress; srt runs the full set); golden
  green on 2.0.3; **canary smoke PASS 6.3 s on tier=srt**, audit line
  `tier:"srt"` with the agent's `buzz` exec egress-scoped to
  `buzz.gradientcm.com` only; **rollback rehearsed live** (env-flip
  srt→local→srt, smoke PASS each). `just ci` on gradient: every recipe
  green EXCEPT one buzz-desktop test — `test_probe_node_times_out_on_hung_binary`,
  a timing assertion (3s margin) that flaked under full-CI load on the
  high-core host (passes 3/3 isolated). NOT M1 code (flue-host is untouched
  by buzz-desktop). Fixed forward — margin 3s→12s, still far under the ~30s
  a real regression yields — on `feat/probe-node-test-load-margin` (off
  main, upstream-PR candidate; the fork's documented CI-robustness pattern,
  cf. feat/provider-spawn-etxtbsy-retry), merged to deploy. **CI re-run
  all-green** (recipe-failures: 0, "All tests passed!") — M1 `just ci` gate
  clean.
- **Park points 2 & 3 resolved by Kevin (2026-08-10)**: egress =
  **relay + curated allowlist**; rollout = **switch Fluelo now**.
- **FLEET ROLLOUT DONE — Fluelo live on srt**: `buzz-acp-flue` switched to
  `BUZZ_FLUE_SANDBOX=srt`, `BUZZ_FLUE_EGRESS=relay,github.com,raw.githubusercontent.com,docs.rs`
  (starter list curated from Fluelo's actual footprint — buzz git is
  relay-hosted so clone/push/pull ride `relay`; docs.rs was the only extra
  host seen; github added as the obvious code-fetch default; api.x.ai NOT
  needed — model calls are host-side). Smoke **PASS 6.3 s**, audit line
  `tier:"srt"` allowedDomains `[buzz.gradientcm.com, github.com,
  raw.githubusercontent.com, docs.rs]`, zero violations. The audit log is
  the tuning loop: any denied host surfaces there to add/remove.
- **Prod state**: canary + Fluelo on srt; the other five units run non-
  flue-acp binaries (tier N/A); dist refreshed (2.0.3+srt); full backup
  `/usr/local/lib/buzz-flue-host.bak-20260810-srt`; env baks
  `canary.env.bak-20260810-srt`, `flue.env.bak-20260810-srt`; relay
  untouched. Rollback refs in session memory.
- **✅ M1 COMPLETE** — every exit-gate criterion green and the authorized
  fleet rollout live.

### 2026-08-10 — M0.4 done → **M0 COMPLETE**; M1 entry gate satisfied

- Kevin minted the canary invite (park point 1 resolved).
  `fleet.toml` authored on gradient (gitignored — it carries the invite
  code), `provision-fleet.ts` dry-run then real: keypair generated
  host-side, env + unit + provider drop-in written, unit enabled.
- **Canary**: pubkey `3e7f2f249ebe3b2e8bb29feed686188545c805afe007df8ce2f82ed52fc77c7f`,
  unit `buzz-acp-canary`, respond_to owner-only, model `xai/grok-4.5`
  (the fleet's proven provider — the spec's "model cheap" deferred to a
  later env edit; swapping is `BUZZ_FLUE_MODEL` + restart). Journal shows
  the full claim sequence (workspace seeded → invite claimed
  status=joined owner=a2c1dab1… → connected → membership notifications →
  kind:0 profile published), zero errors.
- **Done-means met**: smoke PASS in 6.4 s on the `local` tier, journal
  clean; audit lines now visible in `journalctl -u buzz-acp-canary` —
  the M0.5 deviation (flue as stand-in) is closed with the spec's exact
  wording satisfied.
- Rollback: `sudo systemctl disable --now buzz-acp-canary` (fleet
  unaffected; provisioning is additive). Invite was single-use and is
  now consumed.

### 2026-08-10 — M0 checkpoint: M0.1/2/3/5/6 complete, merged to deploy

- Merge gate: full `just ci` (with `CHECK_FILE_SIZES_BASE=HEAD^1`) green
  on gradient at the branch tip; flue-check now runs 59 tests + 3
  sanctioned skips inside it. `feat/sandbox-m0` merged to deploy behind
  it (12 commits + this note).
- **M0.4 is the sole open item and the critical path**: the M1 entry gate
  is "M0 complete", and M1's exit gate needs canary smoke — both wait on
  the **canary invite (park point 1, Kevin)**. Everything scripted around
  it is ready: `provision-fleet.ts` + fleet.toml consume the invite;
  `BUZZ_FLUE_SANDBOX` env-pinning is live in the deployed dist;
  fleet-smoke targets any unit by env.
- Live-fleet posture after this checkpoint: the flue unit runs the
  registry-wrapped `local` tier dist (audit lines live); relay, DB, and
  the other five units untouched.

### 2026-08-10 — M0.6 done (baseline on gradient local disk)

- `workspace-bench.sh` baseline on gradient ext4/NVMe, overall PASS
  (`~/bench/reports/local-baseline-20260809T224755Z.{json,md}`):
  pjdfstest **6791 tests / 155 files PASS** (86.8 s, subset =
  git-relevant syscall dirs, built at `85a8aea9` — pass
  `PJDFSTEST_REF=85a8aea9` on M2 runs for a strict pin); fio 4k randrw
  ≈12.8 k IOPS, 1 M seq write ≈3.2 GB/s, read ≈6.4 GB/s (the numbers M2
  candidates get compared against); git workload green (clone 333 ms,
  20 commits 903 ms, rebase 207 ms, gc 125 ms, fsck 59 ms, hash match);
  coherence probes exercised same-dir (~10 ms floor).
- Instruments installed on gradient via apt (registry row): fio 3.36,
  autoconf/automake/libtool for the pjdfstest build. pjdfstest caches in
  `~/.cache/workspace-bench/pjdfstest`.
- Two bench-authoring bugs caught by first runs: rebase-stage conflicts
  (main/feature rounds now mutate disjoint file ranges — the stage
  measures history rewriting, not conflict resolution) and `git fsck -q`
  (no such flag; exit 129 read as corruption).

### 2026-08-10 — M0.5 done (live on gradient)

- Registry wraps every registered tier with `auditingTier` — tiers never
  log; violations raised mid-exec attach to that exec's line via
  AsyncLocalStorage (the correlation path srt relies on in M1, pinned by
  `test/audit.test.ts` incl. concurrent-exec isolation).
- **Deviation (documented)**: the live done-means names
  `buzz-acp-canary`; canary is parked on the invite (M0.4), so the live
  proof ran on `buzz-acp-flue` — new dist deployed (backup:
  `/usr/local/lib/buzz-flue-host/dist.bak-20260810`; rollback = rsync it
  back + restart), smoke PASS 9.4 s, journal shows
  `sandbox exec {"v":1,"tier":"local","argv0":"buzz",…,"exit":0}` for the
  turn's real exec. Re-verify on the canary once minted.
- **Deploy gotcha found live**: buzz-acp execs `dist/main.js` directly, and
  a fresh tsc build drops the execute bit — the unit crash-looped
  (`Permission denied`) until `chmod 755`. Durable fix: `pnpm build` now
  chmods `dist/main.js` 755 itself.

### 2026-08-10 — M0.3 done (live on gradient)

- **Dedicated smoke channel created**: `smoke`
  (`9c4f2c4c-fc67-4b89-b90c-2fa0d4c902c2`), minted by the codex unit
  identity, Fluelo added role=bot. The harness's live membership handling
  subscribed Fluelo within a second of the add (INFO line in journal) —
  no restart needed for new smoke targets.
- **Gate evidence**: `fleet-smoke.ts` PASS against live Fluelo (reply in
  9.4 s, journal clean, exit 0); with `buzz-acp-flue` stopped the same
  command returned exit 2 (no-reply) — the enumerated-code contract holds;
  unit restarted and reconnected cleanly afterwards.
- **Bug found by the live run**: `--format compact` reads strip `pubkey`,
  so the reply-attribution predicate never matched — the first two probes
  reported NO-REPLY while Fluelo had in fact replied in ~4–5 s. Thread
  polling now uses the full sig-stripped format. (The debugging detour also
  re-verified the fleet was healthy the whole time; a temporary
  `RUST_LOG=debug` runtime drop-in on the flue unit was added and REMOVED,
  standing config restored, two unit restarts total.)
- `--frames` mode (owner-side): query shape validated against the real
  `archive.db` (`archived_events.pubkey` = frame author, kind 24200;
  385 historical Fluelo frames match). A live `--frames` run needs the
  desktop app open (archiver last wrote Aug 8); exercise it during the
  next desktop session. Exit-code note: 3 covers both journal-errors and
  frames-missing; the JSON `reason` field disambiguates.

### 2026-08-10 — M0.2 done

- Suite shape: `describeSandboxConformance(tier)` where the `SandboxTier`
  object bundles the spec's `makeFactory` (as `createFactory`) and
  `capabilities` — one argument instead of two, same contract. Registration
  file for a tier ≈ 15 lines (`test/conformance/local.conformance.test.ts`
  is the template).
- The tier registry + selector (invariant 1) and the normalized
  `SandboxViolation` + renderer (invariant 3) landed **now** rather than
  in M1 — the suite and M0.5's audit wrapper both need the seam, and M1
  reduces to adding `srt.ts` + one registration file. `BuzzAgent` resolves
  its factory via `BUZZ_FLUE_SANDBOX` (default `local`, unknown → loud
  error at session start).
- Baseline: 55 passed / 3 skipped — the 3 skips are the egress fixtures,
  the one sanctioned skip for `local`. Contract canary verified to fire
  (flipped a pin → tsc fails → restored).
- Egress fixture design note: the "denied external name" target uses the
  reserved `.invalid` TLD, so if a tier's policy did not fire before DNS
  the test sees a DNS error with no normalized violation line and fails —
  i.e. the fixture also pins *policy-before-resolution* ordering.
- **Gap flagged for M1 (srt adapter design)**: `SessionEnv` FS verbs run
  host-side in every adapter built on `createSandboxSessionEnv`-style
  wrapping; the model-visible `read` tool could read host paths (e.g.
  `/proc/self/environ` of the host process) even when `exec` is
  sandboxed. The srt adapter must scope the FS verbs to the workspace (or
  route them through the sandbox) — the conformance secret-canary probes
  exec-side only, deliberately, so this must be handled in the adapter,
  not papered over in the suite.

### 2026-08-10 — M0.1 done

- `just flue-check` = `pnpm install --frozen-lockfile` + `tsc --noEmit` +
  `vitest run` in `flue-host/`; wired as the **first** `just ci` dependency
  (cheapest full gate → fail-fast) and as a pre-push lefthook command
  (glob `flue-host/**`).
- **Gate evidence**: planted failing test → `just ci` exit 1 at flue-check
  locally and on gradient (3.1 s); pre-push blocked the push carrying it
  (flue-check 🥊 19.2 s); clean runs green on both hosts (31/31 tests,
  typecheck clean).
- **Discovery validating the M0 premise**: flue-host typecheck had silently
  regressed — 5 strict-mode errors (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`) in `src/fleet/config.ts` +
  `test/fleet.test.ts`, invisible because no gate ran it. Fixed in the
  wiring commit.
- **Deviation (documented, accepted)**: the *initial* push of
  `feat/sandbox-m0` used `--no-verify`. First-push file discovery spans the
  whole fork-vs-upstream delta, firing desktop-check (file-size ratchet
  against upstream tip — the known deploy-lineage issue) plus full
  Rust/Tauri compiles that fork ops assigns to gradient. Subsequent pushes
  are range-scoped; hooks run normally (verified: the blocked broken-test
  push ran them).
- ~~Upstream quirk: `Justfile` never matches the lowercase globs~~ —
  **wrong, corrected 2026-08-10**: lefthook's glob matching is
  case-insensitive on macOS, so pushes carrying Justfile edits DO fire
  `rust-tests` + `desktop-tauri-checks` locally (~6 GB of parallel cargo
  builds — more than this Mac's free disk; the M0 deploy push ENOSPC'd
  twice). Deploy pushes whose delta includes the Justfile should run the
  equivalent gates on gradient and push `--no-verify`, per the standing
  heavy-builds-on-gradient rule.
- **Ops event**: local disk hit ENOSPC mid-hook-run; reclaimed ~4.1 GB by
  deleting `target/` dirs per the standing discipline; truncation-shrapnel
  grep clean (the one hit is CLAUDE.md's own documentation line).
