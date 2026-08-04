# Isolated Agent Execution — Plan of Record

> **Fork-local planning doc (deploy branch only — never upstream).**
> Status: **v2, 2026-08-04** (v1 2026-07-29). Owner: Kevin.
> v2 decision: **Flue is the default harness tier** (topology T2, below), and
> its v1 implementation ships **in this repo** at [`flue-host/`](flue-host/).
> The agentOS isolate tier is retained as the sandbox-hardening phase, not
> the entry point.

## Goal

Move Buzz agent execution from host-trusted local processes to isolated,
supervised, remote-friendly execution — without modifying block/buzz. Two
properties drive everything:

1. **Attach compute, not agents.** Agents come and go; the durable things
   are the identity (keypair + auth tag), the workspace, and the
   conversation. Execution attaches to those.
2. **Credentials land safely.** Ring 0 (nsec + NIP-OA tag) stays with
   buzz-acp on the host. Ring 1 (LLM credentials — API keys and
   subscription OAuth) stays in the harness/provider layer on the host.
   The sandbox sees only the BUZZ_* vars the `buzz` CLI needs. Nothing
   secret is ever written to a workspace, a mount, or a persisted session.

## Topologies

**T1 — agent-in-VM** (agentOS registry agents: Claude Code, Codex,
OpenCode, Pi). The frontier product runs inside the isolate; credentials
must reach it (session env or egress-proxy header injection); native
binaries don't run; MCP and git auth need translation.

**T2 — harness-on-host, sandbox-for-exec** (Flue; same shape as
Cloudflare computer). The harness and model calls run in the trusted host
process; only tool execution enters the sandbox. Credentials structurally
cannot reach the sandbox; the native `buzz` CLI and git work; MCP
translation is unnecessary.

**Decision (Kevin, 2026-08-04): T2 with Flue is the default.** The frontier
CLI wrappers are not load-bearing enough to anchor the architecture on T1;
a programmable harness is. T1 remains available for any agent where a
frontier wrapper is genuinely wanted.

What T2 deleted from v1 of this plan (the simplification ledger):

- ~~mcpServers translation / host-side HTTP MCP~~ — Flue serves the coding
  toolset natively over its sandbox; the Buzz surface is the `buzz` CLI,
  host-native. (Declared stdio servers: env forwarded, spawn skipped.)
- ~~in-VM git auth (hardest Phase-0 gate)~~ — git runs host-side where
  `git-credential-nostr` works.
- ~~wasm32-wasi buzz-cli port~~ — native CLI in the sandbox.
- ~~ACP-fidelity risk of a foreign shim~~ — `flue-acp` is ours, and a
  golden-transcript test replays the exact buzz-acp dialect
  (`flue-host/test/golden.test.ts`).

## Architecture (default tier, shipped v1)

```
systemd unit (per agent, unchanged model: /etc/buzz-agents/<name>.env)
│
├── buzz-acp            (released binary, native, unmodified)
│     │  ACP over stdio — BUZZ_ACP_AGENT_COMMAND=flue-acp
│     ▼
├── flue-acp            (flue-host/, Node/TS, embeds @flue/runtime in-process)
│     • one Flue instance per ACP session (long-lived, per channel)
│     • session/new.cwd → sandbox root; systemPrompt → agent instruction
│     • conversation-stream chunks → session/update (text, thoughts,
│       tool_call pending/in_progress/completed/failed); keepalives;
│       cancel → durable abort → stopReason "cancelled"
│     ▼
└── Flue agent
      ├─ model: BUZZ_FLUE_MODEL via pi providers — credentials host-side
      └─ sandbox: local(cwd) v1 → bash/read/write/edit/grep/glob
         env allowlist: BUZZ_RELAY_URL / BUZZ_PRIVATE_KEY / BUZZ_AUTH_TAG /
         BUZZ_ACP_DISPLAY_NAME — nothing else leaks in
```

Verified end-to-end by `flue-host/test/` (14 tests): the golden transcript
runs the real Flue runtime with a scripted model and a **real** sandboxed
`bash` execution, asserting env forwarding, cwd rooting, update ordering,
and stopReason mapping; protocol tests pin the five known ways an agent
breaks against buzz-acp (non-JSON stdout, dropped systemPrompt, unanswered
cancel, success replies to unknown methods, env-as-map).

## Contracts consumed (why block/buzz stays untouched)

| Seam | Contract | Where defined |
|------|----------|---------------|
| Agent process | ACP over stdio, any command | `crates/buzz-acp/src/config.rs` (`BUZZ_ACP_AGENT_COMMAND`/`_ARGS`) |
| Provisioning | `BUZZ_RELAY_URL` + `BUZZ_PRIVATE_KEY` + `BUZZ_AUTH_TAG` env | `crates/buzz-acp/src/lib.rs` (`resolve_agent_owner`) |
| Identity bootstrap | `buzz invites claim`, `buzz agents mint-tag`, `scripts/new-standalone-agent.sh`, `docs/standalone-agents.md` | deploy branch |
| Relay | WS + NIP-42, REST `/query` `/events`, NIP-98 git, Blossom | public wire surface |
| Desktop deploys (later) | `buzz-backend-<id>` executable, JSON stdin/stdout, ops `info`/`deploy` | `desktop/src-tauri/src/managed_agents/backend.rs` |

The ACP dialect itself (buzz's `protocolVersion: 2` squat) is transcribed
in `flue-host/src/acp/protocol.ts`; `crates/buzz-agent` remains the Rust
reference implementation.

## Design decisions (settled)

1. **In-repo `flue-host/`, not a separate repo** *(v2 reversal of v1's
   decision 1)*. An upstream-absent top-level directory merges trivially in
   `buzz-sync` (upstream never touches it), keeps one deploy flow, and
   stays out of the Rust workspace. `flue-host/pnpm-workspace.yaml` marks
   it a standalone pnpm root so installs can never reach the repo-level
   lockfile — the original contamination worry, now enforced rather than
   avoided.
2. **buzz-acp stays the Nostr-side harness**, consumed as a release binary.
   No TS rewrite of gating/queueing/observer logic.
3. **Flue is the agent tier; `flue-acp` is ours.** No foreign shim between
   buzz-acp and the harness — the adapter is ~600 lines with a golden test,
   and it is the seam where every protocol judgment lives.
4. **Workspace durability comes from the substrate, not the harness.**
   v1: the nest on host disk, exactly like today's units. Next: S3-backed
   workspace (JuiceFS-class — metadata in Postgres/Redis, chunks in
   MinIO/R2; the stack already runs all three) mounted per agent, cwd set
   by provisioning; neither buzz-acp nor flue-acp changes.
5. **Media stays event-mediated.** No writable Blossom mounts ever;
   publishing = upload **plus** a referencing event.
6. **Pin everything preview.** `@flue/runtime 2.0.1`, `@earendil-works/pi-ai
   0.83.0` (exact, committed lockfile). `@rivet-dev/agentos` is
   deliberately **not** a v1 dependency — it returns, pinned, with the
   sandbox tier. pnpm's `minimumReleaseAge` policy stays on (it caught
   day-old transitives on first resolve; keep it).
7. **Credentials: three rings.**
   - *Ring 0 — Buzz identity (nsec, NIP-OA tag):* buzz-acp process env
     only. Conditioned tags (expiry/scoping/rotation) remain the Phase 5
     upstream fix; a remote signer is the eventual answer.
   - *Ring 1 — LLM credentials:* host process env, consumed by the pi
     provider layer. API keys today. Subscription OAuth where sanctioned:
     **xAI first-party OAuth** (SuperGrok/X Premium+; hermes-agent is the
     reference client — already in this fleet) and **OpenAI's Codex OAuth**
     (de-facto tolerated in third-party harnesses; personal-use terms;
     revocable — architect to degrade to API keys per account).
     **Anthropic is excluded**: consumer ToS bind subscription OAuth to
     Claude Code itself; running Claude models here means API keys.
   - *Ring 2 — sandbox env:* the BUZZ_* allowlist, nothing else.
   **Owner-account broker (Phase 4):** accounts are linked per *owner* on
   the desktop (browser lives there; device-code flows complete there),
   token pairs travel via the deploy payload, the host service is the
   single refresher per account, agents get short-lived access tokens (or
   loopback-proxy header injection), budgets per agent enforced at the
   broker and metered into kind-44200 turn metrics. One owner's plans power
   that owner's agents — never one subscription fanned across tenants.

## Implementation path

### Phase 0 — Spike gates ✅ (closed 2026-08-04, in-repo)

- [x] ACP fidelity: golden transcript drives flue-acp exactly as buzz-acp
      does (initialize → session/new → prompt → updates → stopReason;
      cancel; steering trap; -32601 discipline). `flue-host/test/`.
- [x] Sandbox exec: real `bash` in Flue's `local()` sandbox, cwd-rooted,
      env-allowlisted (golden test asserts both).
- [x] Provider seam: pi provider registration + scripted faux model;
      xai / openai-codex / anthropic factories confirmed present in
      pi-ai 0.83.
- [x] Built binary smoke over real stdio (initialize + session/new).

### Phase 1 — Single-agent shadow on gradient (next)

- Provision **one new agent identity** via the standalone path (additive to
  prod; the five existing units untouched). Env: two changed lines
  (`BUZZ_ACP_AGENT_COMMAND`, `BUZZ_ACP_AGENT_ARGS=`) + `BUZZ_FLUE_MODEL` +
  provider key. Runbook: `flue-host/README.md`.
- Exit criteria: mention → correct threaded reply via the sandboxed `buzz`
  CLI; `!cancel` works end-to-end; git push from the sandbox against relay
  git (needs `git-credential-nostr` on PATH + key in sandbox env — verify;
  the harness-side credential wiring gap flagged 2026-08-04 applies);
  48h soak beside the native fleet.
- Fast-follow in this phase: emit `usage_update` (turn metrics parity).

### Phase 2 — Sandbox hardening tier

The `useSandbox` seam is the whole integration surface. Candidates, in
order: **agentOS sandbox** (re-add `@rivet-dev/agentos` pinned; spike its
rivetkit/actor requirements and the `agentOSSandbox` glue Flue shipped
2026-07-23), or **container sandbox** per agent. Either way: default-deny
egress (relay + nothing; model traffic no longer exists inside), per-agent
FS scope, and the Ring-2 allowlist unchanged.

### Phase 3 — Fleet migration (gradient)

- Migrate `buzz-acp-claude` / `buzz-acp-codex` unit *identities* onto
  flue-acp with API-key (or broker) providers — same nsec + tag, two env
  lines, tagged rollback. The frontier-wrapper path stays available but is
  no longer the default for new agents.
- hermes/hermesgpt/threemes: unchanged (own harness; note hermes already
  speaks xAI OAuth — a candidate first consumer of the broker).

### Phase 4 — Provisioning & control plane

- Owner-account broker (decision 7): desktop link flows, deploy-payload
  delivery, host-side refresh, per-agent budgets.
- `buzz-backend-flue` provider executable (desktop `info`/`deploy` → host)
  for desktop-managed creation; host claims agent-typed invites directly so
  the desktop stops being a SPOF.
- Per-agent policy file: model, provider/credential class, sandbox kind,
  budgets, mount layout.

### Phase 5 — Upstream scale prerequisites (block/buzz, orthogonal)

Unchanged from v1, still independently justified: durable resume cursors;
wake-on-mention via NIP-PL push leases (enables scale-to-zero);
nest bootstrap already landed (buzz-nest self-seeding, 2026-08-01);
conditioned NIP-OA tags.

### Phase 6 — Multi-tenant hardening (gate before hosting strangers)

Defense in depth around whatever Phase 2 picked; per-agent quotas (S3
prefix size, token budgets via 44200), abuse handling, owner-facing audit.
Tenancy economics come from the broker: every tenant brings their own
model accounts.

## Substrate variants (execution tier)

- **A. Flue T2 on native host — DEFAULT, v1 shipped.** Self-hosted,
  zero new infra, containment = env allowlist only (interim posture,
  explicitly documented).
- **B. Flue T2 + agentOS sandbox.** Adds V8-isolate FS/process/egress
  isolation (~22 MB, 4.8 ms cold start) behind `useSandbox`. Preview
  maturity is the standing risk; pin and wrap.
- **C. Cloudflare Sandboxes + Agents SDK — managed variant.** Full Linux
  containers, buzz-acp unmodified inside, sleep/wake economics; not
  self-hostable — strategic fork of the posture. (v1 notes retained in git
  history; gates: outbound-WS idle cost, FS persistence across sleep,
  egress proxy.)
- **D. Bare containers + JuiceFS — fallback.** Most ops-heavy, zero
  new-vendor risk.

Decision criteria unchanged: self-hosting required → A/B/D. Hostile
multi-tenancy → B or D, gated by Phase 6.

## Risk register

| Risk | Exposure | Mitigation |
|------|----------|------------|
| Flue preview API churn (2.0.x) | rework | exact pins + committed lockfile; all Flue calls behind `engine/` seam; golden test is the canary |
| ACP dialect drift (buzz-acp evolves) | broken turns | protocol transcribed in one file with the contract test; buzz-agent parity checked on sync |
| `local()` containment limits | host compromise ≙ today's posture | explicit env allowlist now; Phase 2 sandbox tier is the fix; never host strangers before Phase 6 |
| OAuth policy revocation (OpenAI) | fleet auth outage | per-account degrade to API keys without redeploy; broker owns the swap |
| xAI OAuth tier gating flux | broker plans wrong | verify against the actual subscription tier before Phase 4 commits |
| better-sqlite3 native build on deploy hosts | install friction | allowlisted build script; `:memory:` default needs no file perms |
| Two-harness fleet confusion | ops mistakes | runbook labels every agent's tier; unit env names the command explicitly |

## References

- In-repo: [`flue-host/`](flue-host/) (adapter, tests, runbook),
  `docs/standalone-agents.md`, `docs/agent-orientation.md`,
  `docs/first-class-member-agents.md`, `docs/git-on-object-storage.md`
- Flue: flueframework.com (docs), `@flue/runtime` 2.0.1, providers via
  `@earendil-works/pi-ai` 0.83 (incl. `openai-codex`, `xai`, `faux`)
- agentOS: `rivet-dev/agentos` (Apache-2.0, preview; Flue support
  2026-07-23) — Phase 2 candidate
- Session memory: `rivet-agentos-compute-substrate`,
  `standalone-agent-join-via-invites`, `gradient-buzz-prod-deployment`
