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
   before replacing; one-command rollback stated per layer; memory entry
   per deploy; heavy builds on gradient; destructive/PG-gated tests only
   against throwaway Postgres (never prod); canary before fleet.
4. **Park points**: decisions listed in § Park points are Kevin's. On
   reaching one: stop, summarize state + options, ask. Do not decide.
5. **This doc is live**: update the status tables as rungs progress; every
   deviation from the spec gets a dated note here, not a silent change.

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
  targets. Assert: allowed reachable; denied blocked; **violation message
  surfaced in the tool result** (shape-asserted — the model must see why).
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
  verification), polls the thread for a reply within deadline, asserts
  fresh kind:24200 observer frames for the target (archive.db is ground
  truth owner-side; relay-side: presence of the reply suffices for the
  script), greps the unit journal window for ERROR.
- Prints PASS/FAIL + reply latency + journal summary; non-zero exit on
  any failure. The doc section for each rung lists the matching
  **rollback one-liner** next to the smoke invocation.
- **Done means**: one command run against gradient returns PASS against
  the current live fleet (Fluelo), and provably fails (non-zero) against
  a stopped unit.

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
A thin wrapper around the active factory in flue-acp emitting one
structured line per exec: `{tier, argv0, cmd_sha256, cwd, ms, exit,
violations[]}` — info level, argv0+hash only (full command text at debug
level only; command lines can carry sensitive content).
- **Done means**: golden test asserts audit lines for its execs; a live
  turn shows them in `journalctl -u buzz-acp-canary`.

### M0.6 — Workspace bench (reproducible pilot instrument)
`flue-host/scripts/workspace-bench.sh <target-dir> [second-mount-dir]`:
generates a synthetic repo (size-controlled, deterministic seed), then
clone → N commits → branch/rebase → `git gc` → `git fsck` → content-hash
verification; optional two-mount coherence check (write on mount A,
read-after-close on mount B, delete/recreate staleness probe). Emits a
JSON + markdown report (timings + correctness verdicts).
- **Done means**: green baseline run on local disk; report schema stable;
  M2 runs the identical script on each candidate FS.

## The ladder (M1+), gates and park points

| Rung | Work | Entry gate | Exit gate | Rollback | Park |
|---|---|---|---|---|---|
| **M1 — srt native light tier** | `srtSandbox()` factory (spawns exec via `srt`); gradient prereqs (`apt install socat`, bwrap/AppArmor smoke); per-agent FS scope + egress allowlist config surfaced in fleet.toml | M0 complete | conformance (all caps incl. egress) + golden + canary smoke green; audit lines show tier=srt | env-pin back to `local`, restart unit | **prod rollout order/timing** (which agents, when); **web-egress policy** per agent class (relay-only vs allowlist vs fetch-tool) |
| **M2 — workspace pilot** | bench (M0.6) on JuiceFS-on-MinIO and SeaweedFS; two-mount coherence; projection trial (bind-mount into a scratch container) | M1 exit (or parallel, read-only wrt fleet) | two bench reports + written comparison in M1 doc | n/a (pilot, no prod mutation) | **MinIO succession strategy** (freeze/fork vs SeaweedFS consolidation vs Garage split) — blocks M2→prod |
| **M3 — heavy tier** | OpenSandbox egress-depth audit vs Docker+srt-proxy vs microsandbox (KVM); vendored sandbox-sdk image as base; workspace projection per M2 outcome; escalation binding registered per-agent (fleet.toml flag) | M2 decision made | egress acceptance tests + conformance (heavy caps) + canary escalation smoke | disable binding flag + stop containers | **tier selection sign-off**; CubeSandbox only if license clarifies |
| **M4 — gVisor pre-stage** | `runsc` + daemon.json runtime entry; per-container opt-in unused until hostile-tenant phase | any time after M3 shape known | `docker run --runtime=runsc` smoke on the heavy image | remove runtime entry | none |
| **M5 (conditional) — isolate tier + broker** | agentOS factory + buzz bridge, and/or nono-style signing broker (nsec out of Ring 2) | explicit trigger: prompt-injection containment need, or srt insufficiency in practice | conformance + smoke as ever | env-pin back | trigger itself is Kevin's call |

## Park points (consolidated — Kevin's decisions)

1. **Canary invite** (M0.4 — small, immediate): mint one.
2. **Web-egress policy** per agent class (gates M1 fleet rollout).
3. **srt prod rollout order/timing** (gates M1 completion).
4. **MinIO succession** (gates M2 → any prod storage change).
5. **Heavy-tier selection** (gates M3 deploy).
6. **M5 trigger** (whether/when the isolate tier is warranted).

## M0 status

| Item | Status |
|---|---|
| M0.1 gate wiring | ☐ |
| M0.2 conformance suite | ☐ |
| M0.3 fleet smoke | ☐ |
| M0.4 canary agent | ☐ (parked on invite) |
| M0.5 audit log | ☐ |
| M0.6 workspace bench | ☐ |
