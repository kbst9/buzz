# agentOS Remote Execution Host — Implementation Plan

> **Fork-local planning doc (deploy branch only — never upstream).**
> Status: draft v1, 2026-07-29. Owner: Kevin. Companion code lives in a
> **separate repo** (`buzz-agentos-host`, to be created) — this doc is the
> plan of record and tracks the block/buzz-side touchpoints.

## Goal

Move Buzz agent execution from host-trusted local processes to isolated,
supervised, remote-friendly execution — without modifying block/buzz. The
execution tier is [Rivet agentOS](https://github.com/rivet-dev/agentos)
(Apache-2.0, npm `@rivet-dev/agentos`, **preview**): a per-agent virtual OS
(V8 isolates + WASM, in-process kernel) providing per-agent filesystem /
network / process isolation, default-deny egress, supervised processes,
automatic session persistence, and S3-compatible filesystem mounts.

What agentOS buys us that nothing else in the current stack does:

1. **Security for shared agents** — per-agent default-deny egress + FS/
   process/env permissions at ~22 MB/agent. Today's model is explicitly
   host-as-trust-boundary: `BUZZ_ACP_PERMISSION_MODE=bypass-permissions`
   default, no path containment in buzz-dev-mcp (`paths.rs` documents this),
   per-Unix-user separation on the agent host. That is untenable once
   shared compute hosts agents owned by different people.
2. **A supervised, persistent runtime** — replaces the unsupervised stdio
   process chain (buzz-acp → adapter → MCP server → shells) with a managed
   process table, idempotent lifecycle API, resource caps, and replayable
   sessions (today: sessions are in-RAM and die on restart).

What agentOS does **not** buy (covered elsewhere, keep out of scope here):
model diversity (comes from the agent harness — pi/goose/buzz-agent already
cover Grok via OpenAI-compatible endpoints), git hosting (relay-native, CAS
on S3 — see `docs/git-on-object-storage.md`), media storage (Blossom), or
the relay-side scaling fixes (§ Phase 5).

## Architecture

```
buzz-agentos-host (new repo, one deployable service per host)
│
├── host service (Node/TS, embeds @rivet-dev/agentos)
│     • per-agent VM lifecycle (getOrCreate / openSession)
│     • per-agent permission policy (egress allowlist: relay + LLM API only)
│     • per-agent S3 FS mounts (workspace nest)
│     • host-side HTTP MCP server exposing buzz ops (Phase 2)
│     • provisioning glue: invite claim / auth-tag intake / env assembly
│
├── N × buzz-acp (released sprig binary, native, stateless, unmodified)
│     │   one process per agent identity; BUZZ_ACP_AGENT_COMMAND=agentos-acp
│     ▼
├── N × agentos-acp shim (small Node pkg: ACP-over-stdio ⇄ agentOS session)
│     ▼
└── N × agentOS VM session (claude-code | codex | opencode | pi)
        • FS: in-VM overlay + S3-mounted workspace dirs
        • net: allowlist only
        • tools: registry software (git/rg/curl as WASM) + host MCP
```

Native-binary agents (hermes) **cannot run in-VM**; they stay on classic
hosting (systemd + Unix users) as a second tier until they ship WASM builds
or get their own containment. Document the two-tier security posture
wherever the fleet is described.

## Contracts consumed (why block/buzz stays untouched)

| Seam | Contract | Where defined |
|------|----------|---------------|
| Agent process | ACP over stdio, any command | `crates/buzz-acp/src/config.rs` (`BUZZ_ACP_AGENT_COMMAND`/`_ARGS`, ~line 250) |
| Provisioning | `BUZZ_RELAY_URL` + `BUZZ_PRIVATE_KEY` + `BUZZ_AUTH_TAG` env | `crates/buzz-acp/src/lib.rs` (`resolve_agent_owner`, ~line 117) |
| Identity bootstrap | `buzz invites claim`, `buzz agents mint-tag` (deploy-branch CLI), `scripts/new-standalone-agent.sh`, `docs/standalone-agents.md` | deploy branch |
| Relay | WS + NIP-42, REST `/query` `/events`, NIP-98 git, Blossom | public wire surface |
| Desktop deploys (later) | `buzz-backend-<id>` executable, JSON stdin/stdout, ops `info`/`deploy` | `desktop/src-tauri/src/managed_agents/backend.rs`; precedent: sprout-backend-blox (separate repo) |

MCP note: buzz-acp declares its MCP servers (with `BUZZ_*` env) inside ACP
`session/new` (`lib.rs` `build_mcp_servers`, ~line 4142). The shim must
translate that field; in-VM agents cannot exec the native `buzz` binary, so
tooling arrives via the host-side HTTP MCP (Phase 2) instead.

## Design decisions (settled)

1. **Separate repo**, not a folder here — keeps the Node toolchain out of
   the Rust workspace and out of the `buzz-sync` merge loop. Blox provider
   precedent.
2. **buzz-acp stays the Nostr-side harness**, consumed as a release binary.
   No TS rewrite of gating/queueing/observer logic.
3. **Shim, not fork**: `agentos-acp` bridges stdio ACP to agentOS sessions.
   agentOS's internal agent interface is ACP-based, so this is close to a
   proxy.
4. **Workspace durability for in-VM agents = agentOS S3 mounts.** JuiceFS
   is descoped to the native tier only, if/when needed (metadata engine =
   the relay's existing Postgres; data = same MinIO/R2 class bucket).
5. **Media stays event-mediated.** No writable Blossom mounts ever — blobs
   are immutable + content-addressed; publishing = upload **plus** a
   referencing event (`--attach`), otherwise the file is an invisible,
   immortal orphan. Any file UI is an imeta-derived, channel-scoped index —
   never a raw bucket listing (names + ACLs live in the event graph).
6. **Pin the agentOS version.** It is a preview API; upgrade deliberately,
   never transitively.
7. **Secrets**: nsec + auth tag enter as session env via the host service;
   never written into the VM filesystem or the S3 mount.

## Implementation path

### Phase 0 — Spike (de-risk, ~days)

Scope: local machine or gradient, one throwaway agent identity, test
community or `#agent-dev` channel. No new repo yet; scratch dir is fine.

Validation gates — all must pass before Phase 1:

- [ ] agentOS server up; claude-code session opens; prompt → streamed reply.
- [ ] **ACP fidelity through the shim**: buzz-acp (unmodified) drives a full
      turn — `session/new` → `session/prompt` → streamed `session/update` →
      completion — with the shim as `BUZZ_ACP_AGENT_COMMAND`.
- [ ] **mcpServers passthrough**: the `session/new` mcpServers field reaches
      something usable in-VM (or the shim rewrites it to the host MCP URL).
- [ ] **S3 mount semantics**: mount a bucket dir; write/rename/append from
      in-VM processes; kill the host service mid-write; remount; verify
      state. Then the git gauntlet in-VM: clone (relay repo), edit, commit.
- [ ] **In-VM git ↔ relay auth**: determine how WASM git authenticates NIP-98
      to relay git (native `git-credential-nostr` can't run in-VM). Candidate
      answers: shim-side HTTP proxy injecting auth; JS credential helper;
      host-side clone into the mount. Pick one, prove it.
- [ ] **Egress policy**: verify default-deny; allowlist relay host + LLM API;
      confirm a fetch to any other host fails.
- [ ] Record: cold-start latency, RSS per idle agent, tokens/turn overhead.

Kill criteria: if ACP fidelity or S3+git semantics fail in ways that need
agentOS-core patches, stop and reassess (fall back to container-per-agent +
JuiceFS for everything; keep this doc, revise).

### Phase 1 — Single-agent E2E on gradient (shadow deploy)

- Create `buzz-agentos-host` repo: host service + shim + systemd unit.
- Provision **one new agent identity** via the standalone path
  (`new-standalone-agent.sh` / `invites claim` + `mint-tag`) — additive to
  prod, zero risk to existing units ([[deploy-in-place-no-dev-envs]] still
  applies: don't touch the five existing units).
- Exit criteria: mention → correct threaded reply from inside the VM;
  `!cancel` / observer control frames work; host-service restart → agent
  resumes with session context (agentOS persistence) and workspace intact
  (S3 mount); 48h soak alongside the native fleet with no missed mentions
  beyond the known restart-gap envelope.

### Phase 2 — Buzz tooling in-VM

- Host-side HTTP MCP server, per-agent-scoped (auth: per-agent bearer minted
  by the host service), exposing: messages (get/send/thread/search), repos,
  upload+attach, memory/engrams. The shim injects its URL via mcpServers.
- Nest bootstrap: host service materializes `AGENTS.md` + skills into the
  mount at provision time (today `ensure_nest_at` is desktop-only — remote
  agents currently reference an AGENTS.md that doesn't exist).
- Stretch (upstream candidate, separate feat branch): `wasm32-wasi` build
  target for buzz-cli so agents get the real CLI in-VM.

### Phase 3 — Fleet migration (gradient)

- Migrate `buzz-acp-claude` and `buzz-acp-codex` units into the host
  service (same identities: reuse nsec + auth tag from `/etc/buzz-agents`).
  One at a time, tag rollback points, old unit disabled-not-deleted.
- hermes/hermesgpt/threemes stay native — explicitly documented two-tier
  posture.
- Ops runbook in the new repo: deploy, rollback, logs, per-agent policy
  edits, agentOS version-pin upgrades.

### Phase 4 — Provisioning & control plane

- `buzz-backend-agentos` provider executable (desktop `info`/`deploy` →
  host service API) for desktop-managed creation.
- Standalone onboarding: host service claims agent-typed invites directly —
  desktop stops being a SPOF for hosted agents.
- Per-agent policy file (egress allowlist, mount layout, model/API keys).

### Phase 5 — Upstream scale prerequisites (block/buzz work, orthogonal)

These are feat branches against main (upstream candidates), valuable with
or without agentOS; the host works without them at today's reliability
envelope:

- **Durable resume cursors** — per-channel `last_seen` as a replaceable
  relay event; today a harness restart replays from ~boot−5s and downtime
  silently drops mentions (`relay.rs` since-filter logic, `startup_watermark`).
- **Wake-on-mention** — reuse the NIP-PL push-lease matcher/delivery worker
  (`push_runtime.rs`, kind 30350) to hit a host-service webhook for offline
  agents → enables scale-to-zero.
- **Nest bootstrap in the harness** (or provider), not the desktop.
- **Conditioned NIP-OA tags** — expiry + kind scoping + rotation flow;
  today's tags are non-expiring bearer capabilities shipped raw to hosts.

### Phase 6 — Multi-tenant hardening (gate before hosting strangers)

- Defense in depth: per-tenant container/VM around the agentOS host
  process; agentOS isolation is one layer, not the only one (preview-grade,
  isolate-based).
- Per-agent quotas (S3 prefix size, token budgets via turn metrics kind
  44200), abuse handling, owner-facing audit trail.

## Risk register

| Risk | Exposure | Mitigation |
|------|----------|------------|
| agentOS preview API churn | rework | pin version; wrap all agentOS calls in one adapter module |
| Isolate escape (young sandbox) | cross-agent compromise | Phase 6 container wrap before hostile tenancy; keep secrets out of VM FS |
| ACP dialect drift (shim vs buzz-acp expectations) | broken turns | Phase 0 gate; golden-transcript test replaying a recorded buzz-acp session |
| In-VM git auth unsolved | agents can't push | Phase 0 gate with three candidate designs |
| S3 mount crash semantics | lost/corrupt workspace | Phase 0 kill-mid-write test; nest docs are small/flat; repos re-cloneable |
| claude-code under Node-emulation edge cases | subtle tool failures | soak in Phase 1; keep native units until Phase 3 sign-off |
| Two-tier fleet confusion | ops mistakes | runbook labels every agent with its tier |

## Non-goals

- Modifying block/buzz for the add-on itself (Phase 5 items are separate,
  independently-justified upstream work).
- Model diversity via agentOS (harness-level: pi/goose/buzz-agent already
  cover xAI/Grok etc.).
- Writable media mounts or raw bucket file listings.
- Replacing the relay event graph as the source of truth for anything.

## References

- agentOS: repo `rivet-dev/agentos`, docs `agentos-sdk.dev` (v0.2, 2026-06)
- pi + ACP: `svkozak/pi-acp`, Zed ACP agent registry
- ArtifactFS (`cloudflare/artifact-fs`) — candidate for fast `REPOS/`
  materialization on the **native** tier; not applicable in-VM
- In-repo: `docs/standalone-agents.md`, `docs/first-class-member-agents.md`,
  `docs/git-on-object-storage.md`, `CONNECTED_AGENT_PARITY.md` (doc-style
  precedent)
- Session memory: `rivet-agentos-compute-substrate`,
  `standalone-agent-join-via-invites`, `gradient-buzz-prod-deployment`
