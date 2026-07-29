# Cloudflare Hosted Agents — Integration Design

> **Fork-local design doc (deploy branch only — never upstream).**
> Status: draft v1.2, 2026-07-29 (v1.1: Deploy-button provisioning — no CF
> credentials anywhere; v1.2: worker-side LLM gateway — no LLM credentials
> in the sandbox). Detailed design for **substrate variant B** of
> [AGENTOS_HOST_PLAN.md](AGENTOS_HOST_PLAN.md) — Cloudflare Sandboxes +
> Agents SDK as the managed execution tier. That doc holds the substrate
> decision criteria; this one holds the Cloudflare-specific design.

## Summary

Buzz agents run on Cloudflare as: **one host Worker per CF account** (not
per agent), a **Durable Object per agent** (supervisor: lifecycle, cursor,
wake endpoint, config), and a **Sandbox per agent** (full Linux container:
persistent FS, sleeps idle, wakes on request) running the **unmodified
sprig tree** — buzz-acp → ACP adapter (pi / claude-code / codex) →
buzz-dev-mcp — exactly as on gradient. **Buzz never holds Cloudflare
credentials**: the user deploys the host Worker into their own account via
a Deploy-to-Cloudflare button, and everything afterwards goes through the
Worker's own NIP-98-authenticated ops API (§ Provisioning). The desktop
provider seam (`buzz-backend-cloudflare`) stays as a thin client of that
API; no block/buzz changes.

```
CF account (user-owned, connected once)
└── buzz-cf-host Worker  (ONE per account; versioned release, redeployed to upgrade)
    ├── Agent DO "npub…A"  ── supervises ──►  Sandbox "npub…A"
    ├── Agent DO "npub…B"  ── supervises ──►  Sandbox "npub…B"
    │     • SQLite: per-channel cursor, lifecycle state, snapshot log
    │     • HTTP: wake webhook (NIP-PL target), ops API (status/logs/policy)
    │     • alarms: snapshot cadence, idle policy, health checks
    │
    └── Sandbox contents (per agent):
          buzz-acp (native, unmodified) ──stdio/ACP──► adapter (pi-acp | claude-agent-acp | codex-acp)
          workspace nest on sandbox FS (+ snapshot/restore)
          REPOS/ via git clone or ArtifactFS
          egress: relay host + LLM proxy only
```

Relay note: the prod relay already sits behind a Cloudflare tunnel
(`wss://buzz.gradientcm.com` via cloudflared), so sandbox→relay traffic is
CF-internal-adjacent — latency should be excellent. Host-header tenancy is
a non-issue (real DNS name).

## The characterization, corrected

Original sketch → what the design actually does, and why:

1. **"UI gets a Cloudflare API key input in integrations settings"** —
   *superseded in v1.1: no Cloudflare credentials exist anywhere in the
   system (§ Provisioning).* The original v1.0 reasoning stands as context
   for why they never belonged in the desktop payload: The
   provider payload validator **rejects credential-shaped keys** in
   `provider_config` (any key word-matching `secret|password|token|key|
   credential` — `desktop/src-tauri/src/managed_agents/backend.rs`
   ~380–410). That ban exists so providers, not the desktop payload, own
   their credentials. v1: `buzz-backend-cloudflare` reads the CF API token
   from its own config (`CLOUDFLARE_API_TOKEN` env or wrangler's existing
   login state) — zero desktop changes. A desktop "Integrations" panel
   storing the token in the OS keyring and exporting it to the provider's
   process env is a later polish (P2), not a prerequisite. Use a **scoped
   API token** (Workers Scripts:Edit, DO, Containers, account-level), never
   a global API key.

2. **"New agent type in connected agents: 'Hosted', cloudflare selectable"**
   — *right idea, wrong mechanism: this is not a new agent type.* The
   desktop already models this as `BackendKind::Provider { id, config }`
   (`managed_agents/types.rs:6`) with PATH-discovered `buzz-backend-<id>`
   executables and a "Where to run" UI that warns the key leaves the
   machine. Cloudflare appears as provider id `cloudflare` the moment the
   binary is on PATH. "Hosted" as a UI grouping label is fine; the data
   model already exists.

3. **"Creating an agent creates a new Worker in the account"** — *no: one
   Worker per account, one DO + Sandbox per agent.* Worker-per-agent means
   N script deploys, N versions to migrate, and API-token script-quota
   burn. The Agents SDK pattern is a single Worker exposing a DO namespace;
   agent creation = `getOrCreate(DO named by agent pubkey)` + config write
   + sandbox provision. The host Worker is deployed once at integration
   time from a **pinned release** and upgraded deliberately.

4. **"Base worker is a coordination/attach point that loads filesystem +
   git then attaches a sandbox"** — *right role, one correction: the DO
   never touches a filesystem (it has none — SQLite only).* It **directs**
   the sandbox: boot → restore latest snapshot if FS is cold → materialize
   repos (git clone in-sandbox; ArtifactFS candidate for big repos) →
   start buzz-acp → confirm relay auth. The DO additionally owns what the
   sketch missed: the **durable per-channel cursor**, the **wake webhook**
   (NIP-PL delivery target), snapshot cadence, idle policy, and an ops API.

5. **"UI for people to add LLM credentials to load into the sandbox?"** —
   *collect them, but do NOT load them into the sandbox.* Sandboxes support
   egress-proxy credential injection: outbound handlers run in the Workers
   runtime, hold the secret, and attach it in transit — the sandbox never
   sees the API key. Adapters point at the proxy via base-URL overrides
   (`ANTHROPIC_BASE_URL`, OpenAI-compatible base URLs — pi/codex/claude
   all support this). v1 fallback: plain env injection (existing per-agent
   `env_vars` flow already merges global < persona < agent); proxy
   injection is the hardening step. Superseded in v1.2: both credential
   types now sit behind the worker-side gateway — see § LLM credential
   gateway. The one secret that MUST enter the
   sandbox is the **nsec** (event signing happens in buzz-acp) — pushed as
   a Worker/DO secret, injected at sandbox boot, never written to the FS
   or snapshots. This is why conditioned NIP-OA tags (expiry, kind scope)
   are urgent on this substrate.

6. **"ACP runs on the sandbox on spin up, sandbox runs e.g. pi"** —
   *correct; sharpened:* the sandbox runs the whole sprig tree unmodified —
   buzz-acp is the process that "runs ACP", spawning the adapter over
   stdio. pi (via pi-acp) is a good default for model breadth (Anthropic /
   OpenAI / Google / xAI-Grok / any OpenAI-compatible); claude-code and
   codex are equally supported. Native git + `git-credential-nostr` +
   native `buzz` CLI all work as-is — this is the variant's core advantage
   (four of the agentOS Phase 0 gates don't exist here).

7. **"Upgrade to V8 isolates for faster/cheaper execution?"** — *not an
   upgrade knob — a different substrate.* Plain isolates cannot run
   buzz-acp (native), nor pi/claude-code (process-spawning CLIs needing a
   FS and shells). "Agents in isolates" is precisely substrate A (agentOS's
   virtual-OS trick) with all its gates: shim, no native binaries, in-VM
   git auth. The honest future version is a **hybrid**: light chat-only
   turns in an isolate-hosted harness, escalating to the sandbox for real
   work — plausible eventually (agentOS sandbox-mounting and Cloudflare's
   own harness direction, e.g. Flue, both point there), but it is P4+
   research, not a v1 lever. Also: the cost pressure is lower than assumed —
   sleeping sandboxes + active-CPU pricing already make idle agents cheap;
   isolates mainly buy cold-start latency at large fleet scale.

## Provisioning: Deploy-to-Cloudflare button (v1.1 — no CF credentials)

Supersedes the token-based provisioning in correction #1 below. The button
flow removes Cloudflare credentials from every Buzz component:

1. **One-time connect (user's browser, user's account).** The desktop shows
   a "Deploy to Cloudflare" button → `deploy.workers.cloudflare.com/?url=`
   pointing at the public `buzz-cf-host` template repo. Cloudflare's flow
   reads the wrangler config, provisions the declared resources (DO
   namespace, sandbox/container binding), prompts for template vars —
   `OWNER_PUBKEY` (copied from Buzz) and `RELAY_URL` — creates the user's
   own repo copy wired to Workers Builds, and deploys. The user authorizes
   everything inside their own Cloudflare session; no API token ever
   reaches Buzz, the provider, or the desktop.
2. **Pairing.** The user pastes the deployed Worker URL into Buzz. All ops
   calls are **NIP-98-signed by the owner key and verified against the
   pinned `OWNER_PUBKEY`** — the same auth machinery as relay REST and git.
   No bearer tokens exist in the system.
3. **Runtime needs no Cloudflare API at all.** Per-agent DO creation
   (`getOrCreate` on the namespace binding) and sandbox creation happen
   through *bindings inside the Worker* — agent create/start/stop/status/
   snapshot are ops-API calls, not Cloudflare API calls.
4. **Secrets path.** The deploy payload (nsec, auth tag, env) transits
   desktop → ops API over TLS and lands in **DO storage**, injected into
   the sandbox env at boot. Tradeoff vs Workers Secrets (write-only): DO
   storage is readable by our own pinned Worker code, which must read it
   to inject anyway; never written to sandbox FS or snapshots. Documented,
   acceptable.
5. **Upgrades — the one real cost of the button.** The button creates a
   *copy* of the template in the user's repo host, wired to Workers
   Builds; it will drift from the upstream template. Mitigation: keep the
   host Worker tiny and stable; version handshake in the ops API so the
   desktop can show "host v0.3 < current v0.5 — update" with a re-deploy
   link. This replaces v1.0's "pinned release, redeployed to upgrade."

Floor: Sandboxes/Containers require a paid Workers plan — the button flow
surfaces this to the user; it's their account and their bill (which is
exactly the point: bring-your-own-compute).

## LLM credential gateway (v1.2 — no LLM credentials in the sandbox, ever)

Supersedes v1.1's two-mode split (API-key-via-proxy vs OAuth-in-sandbox).
All LLM traffic leaves the sandbox as a call to the host Worker's
**gateway endpoint**; credentials of both types — API keys *and*
subscription-OAuth tokens — live worker-side and are attached in transit.
The sandbox never holds an LLM credential of any kind.

- **Adapter side**: base-URL override only (`ANTHROPIC_BASE_URL` /
  OpenAI-compatible base URLs — the documented gateway pattern for
  claude-code, codex, and pi), plus a per-agent internal grant token
  injected at boot. That grant is a low-value credential: it authorizes
  "proxied LLM access for this agent" and nothing else; rotatable,
  centrally revocable.
- **Gateway = verbatim pass-through streaming proxy, not re-execution.**
  The adapter's own request body and headers pass through untouched
  except for auth attachment. This is the load-bearing detail for
  subscription tokens: the provider still sees the genuine client — it
  *is* claude-code/codex making the request — the proxy only relocates
  where the token is attached. A gateway that constructed its own LLM
  calls would break subscription-token client gating.
- **Placement**: proxy in the stateless Worker layer (SSE streaming is
  mostly I/O wait under active-CPU billing); the **DO** stores
  credentials, mints short-lived grants, and owns the **OAuth refresh
  loop** (standard OAuth2 refresh per provider; buzz-agent's `auth.rs`
  is in-repo prior art for the dance). Keep per-chunk traffic out of the
  single-threaded DO.
- **Login flows target the ops API, not the sandbox.** Device-code and
  desktop token handoff complete against the DO with the sandbox asleep
  or not yet created. Auth is fully decoupled from sandbox lifecycle:
  restored, rebuilt, or migrated sandboxes need zero re-auth, and
  credential setup can precede first boot.
- **Consequences**: sandbox egress allowlist shrinks to **relay +
  gateway, deny-else** (tighter than v1.1); snapshot handling simplifies
  (adapters run in env/base-URL mode and never write token stores — no
  auth dirs to exclude); per-agent metering, rate limiting, and central
  revocation fall out of the gateway for free.
- **Risks**: per-provider refresh quirks (Anthropic / OpenAI / xAI) are
  now gateway code to own; Workers streaming/body/time limits need the
  P0 check with a real adapter turn; subscription usage remains subject
  to provider plan terms and rate windows exactly as on any server — the
  gateway moves where the token sits, not the policy envelope. Plan
  reality: a member's personal agent on their own subscription composes
  perfectly with BYO-compute; dense always-on fleets belong on API keys.

## Lifecycle

**v1 — always-on:** sandbox stays awake holding the relay WS (same
semantics and reliability envelope as a gradient unit, now isolated
per-agent). Measure idle cost in the spike; active-CPU pricing may make
this a non-issue at current fleet size.

**v2 — wake-on-mention (the economics unlock):** requires the two upstream
items from AGENTOS_HOST_PLAN.md § Phase 5 — durable cursors + NIP-PL
lease delivery to a webhook. Flow: relay matcher → DO wake webhook →
sandbox wake → buzz-acp starts → REST `/query` backlog from the DO-stored
cursor → turn → idle timeout → cursor persisted → sandbox sleeps.
DO SQLite is the natural cursor home.

**Snapshots:** DO alarm drives snapshot cadence (e.g. post-turn debounced +
daily); restore drill is a spike gate. Snapshots exclude secrets by
construction (nsec is env-only).

## Implementation phases

- **P0 — Spike (gates):** build the sandbox image (sprig release + adapters
  + git + buzz CLI); run one throwaway identity end-to-end against prod
  relay (mention → threaded reply); **verify the Deploy button provisions
  the container/sandbox binding and Workers Builds builds the image**
  (newest part of the flow — if it can't, fallback is a one-time
  `wrangler deploy` from the user's machine, which weakens the story);
  verify custom-image support, FS persistence across sleep/wake + a
  restore-from-snapshot drill; measure idle cost of a held WS; verify
  egress allowlist (relay + LLM only, deny-else); confirm base-URL
  override works for the chosen adapter; exercise NIP-98 ops-API auth
  against the pinned owner pubkey.
  Kill criteria: custom images unsupported, or held-WS idle cost is
  unacceptable AND wake-path prerequisites are far off.
- **P1 — Provider + ops API:** the host Worker's ops API (create / start /
  stop / status / snapshot / version, NIP-98-authed) plus
  `buzz-backend-cloudflare` as its thin client implementing `info` +
  `deploy` per the backend contract. Desktop works unchanged.
- **P2 — Desktop polish:** Deploy-button + pairing UX (paste Worker URL,
  version handshake surfaced), "Hosted" grouping in connected agents,
  status from the ops API. No token storage — nothing to keep in the
  keyring.
- **P3 — Wake economics:** upstream cursor + NIP-PL webhook work lands →
  flip lifecycle to v2; scale-to-zero.
- **P4 — Hardening/research:** egress-proxy LLM injection as default;
  remote-signer exploration (nsec out of sandbox); hybrid isolate tier
  evaluation; multi-tenant gates per AGENTOS_HOST_PLAN.md § Phase 6.

## Open questions

- Sandbox custom-image workflow and image size limits (sprig + adapters +
  node — verify in P0).
- Exact egress-allowlist granularity available to Sandboxes (domain-level?
  per-request handler?).
- Sandbox placement vs relay region; cold-start latency after sleep
  (matters for v2 wake→first-token time).
- Cloudflare quotas: sandboxes per account, DO storage limits vs fleet
  size, snapshot storage pricing.
- Deploy-button coverage of container bindings + image build in Workers
  Builds (P0 gate; docs confirm DO provisioning explicitly, containers
  ride the same wrangler-config path — verify end-to-end).
- Wake-webhook authentication (relay NIP-PL delivery → DO endpoint):
  signed delivery vs per-lease shared secret.
- DO-storage-for-nsec vs Workers Secrets: revisit if a remote-signer
  lands (nsec out of the sandbox entirely, per P4).

## Non-goals

- Worker-per-agent; plain-isolate agent execution in v1; writable Blossom
  mounts (event-graph rule stands); replacing self-hosted substrates —
  this is variant B alongside A/C, per the decision criteria in
  AGENTOS_HOST_PLAN.md.
