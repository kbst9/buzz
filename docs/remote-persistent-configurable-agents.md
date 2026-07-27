# Remote, persistent, desktop-configurable agents

**Status:** design + implementation path — this branch implements it end to end
**Branch:** `buzz-remote-persistent-configurable-agents`
**Verified against:** `main` @ `37420764`
**Absorbs:** `docs/remote-agent-host.md` (`feat/agent-host-daemon`, design only) ·
learnings from `feat/backend-ssh-provider` (shipping code, superseded) ·
composes with `docs/acp-remote-transport.md` (`feat/acp-remote-transport`, orthogonal)

---

## 1. Goals

1. **Agents execute on a remote server** you own.
2. **Execution survives the desktop** — close the lid, agents keep answering.
3. **Remote agents are fully configurable from Desktop** — create agents on a
   remote host, pick from the host's runtimes, edit instructions, start/stop,
   read logs.
4. **Maintainability first** — reuse Buzz's existing seams; no parallel
   authorization system, no new HTTP surface, minimal privileged code.

The forcing function is goal 2: the `buzz-acp` harness process must live on the
server, supervised there. Desktop's job shrinks to being a control surface.
Everything else follows from that.

## 2. Shape

One new daemon, two new event kinds, one new `BackendKind` in Desktop.

```
Buzz Desktop                        relay                     your server
┌───────────────────┐                                   ┌─────────────────────────┐
│ agent dialog       │      kind 30178 announce         │  buzz-agent-host        │
│  "Run on:          │◀──── (durable, secret-free) ─────│  (community member,     │
│   gradient"        │                                  │   one systemd unit)     │
│                    │      kind 24300 control          │    ├─ buzz-acp (child)  │
│ edit instructions, │────▶ (ephemeral, NIP-44) ───────▶│    ├─ buzz-acp (child)  │
│ start/stop, logs   │◀──── replies (same kind) ────────│    └─ buzz-acp (child)  │
└───────────────────┘                                   └───────────┬─────────────┘
                                                                    │
                                                 agents join the relay as usual
```

- `buzz-agent-host` is a member of the community: it has a keypair, connects
  with NIP-42, publishes a durable **kind 30178** announcement describing which
  runtimes it can launch, and accepts **kind 24300** ephemeral, NIP-44-encrypted
  control frames from authorized members.
- Desktop discovers hosts from 30178 (a plain relay query), and manages
  host-backed agents by exchanging 24300 frames signed with the owner key it
  already holds. A host-backed agent is an ordinary `ManagedAgentRecord` with
  `backend: host` — every downstream feature (personas, teams, mentions,
  presence) behaves normally because the agent itself is unchanged.
- `buzz-acp` needs **zero changes**: it is configured entirely by env vars
  (`crates/buzz-acp/src/config.rs`), so remote deployment is rendering an env
  map on another machine.

### 2.1 Why the control plane is Nostr events

This repo's own rule (CLAUDE.md, "Prefer Nostr events over new HTTP
endpoints") — and it earns its keep here:

- **Authorization is community membership.** The relay already enforces it at
  NIP-42; the host re-checks the sender against the roster. Authorizing a
  teammate to deploy = adding them to the community. Revoking = removing them.
  No SSH keys, no sudo grants, no second credential system.
- **No new ingress.** The host dials *out* to the relay like every other
  member. Nothing on the server listens on the network. No tunnel, no reverse
  proxy, no public hostname.
- **Realtime fan-out for free.** Replies, status changes, and log tails ride
  the connection every participant already has.

The rejected alternatives (reconciling on kind 30177, reusing the 43001–43006
job protocol, HTTP + NIP-98, SSH) are analyzed in the absorbed
`remote-agent-host.md` design; the analysis stands and is not repeated here.
The short version: 30177 is structurally secret-free by design
(`agent_events.rs`), job events are durable and feed-visible, HTTP duplicates
the relay's membership check, and SSH gates on a credential system unrelated
to Buzz.

## 3. Two refinements over the prior design

The absorbed design shipped agent private keys inside encrypted ephemeral
frames and drove systemd via a sudo-scoped install helper. Both are replaced.

### 3.1 Keys are generated on the host and never transit

Prior flow: Desktop generates the keypair, keeps the nsec in the OS keyring,
and sends it to the host inside a 24300 frame (encrypted, ephemeral — but still
transiting).

New flow — **no secret ever crosses the network, in either direction**:

1. `create` — Desktop sends the agent config (no identity material). The host
   generates the keypair, stores the nsec on its own disk (`0600`), persists a
   desired-state record, and replies with the **pubkey**. The agent is not
   started yet.
2. `grant` — Desktop mints the NIP-OA auth tag for that pubkey (attestation
   stays with the owner — the host is never in the identity business) and
   sends it. The host verifies it with `buzz_sdk::nip_oa::verify_auth_tag` —
   the same function the relay uses, so the two cannot disagree — checks the
   owner it names equals the sender, then writes the env and starts the agent.

Desktop performs both steps on one "Create" click; the two-phase split is
wire-level, not UX-level. For host-backed agents, `ManagedAgentRecord` holds
the pubkey and **no `private_key_nsec` at all** — there is nothing to protect
in the keyring and nothing a stolen laptop can leak for these agents.

This also defuses the prior design's worst trust-on-first-use failure mode: a
malicious host can no longer *harvest* keys, because no key is ever sent to
it. (A malicious host can still run the agents you choose to place on it —
inherent to remote execution; see §6.3.)

### 3.2 The daemon supervises children directly — no sudo, no unit templating

The prior design rendered per-agent systemd units and drove `systemctl` through
a sudo-scoped install helper, inheriting `render.rs` from the (unmerged) SSH
provider. That is the design's largest body of privileged code, its only root
adjacency, and its only dependency on an unmerged branch.

Instead: **`buzz-agent-host` spawns `buzz-acp` processes as direct children**
and supervises them itself — restart with bounded backoff on crash, reconcile
from the desired-state store on daemon startup. The daemon is the single
always-on unit on the machine (systemd system or user service — its own
install is one static unit file, written once by a human, not templated).

What this buys:

- **No root-adjacent code.** The daemon runs as one unprivileged user. There
  is no sudoers entry, no install helper, no path from a network message to
  `systemctl`. The prior design's own security analysis called the sudo helper
  "a real trade"; this deletes the trade.
- **No unit templating / escaping surface.** Env rendering is an in-process
  `HashMap<String, String>` handed to `std::process::Command::envs` — no shell,
  no file format to escape, no injection class.
- **No dependency on `buzz-backend-ssh`'s `render.rs`** or on systemd at all —
  the daemon is portable to any host OS.

The trade, stated plainly: agents share the daemon's OS user (no per-agent
user isolation), and a daemon restart bounces its agents (they are respawned
by startup reconcile; agents are stateless between turns, so this is a blip,
not data loss). Per-agent isolation via systemd units can return later as an
alternative `Supervisor` implementation behind the same trait — the protocol
does not know or care how the host runs its processes.

## 4. Protocol

### 4.1 `kind:30178` — host announcement (durable, secret-free)

`KIND_AGENT_HOST_ANNOUNCE`, parameterized replaceable (NIP-33), addressed by
`(host_pubkey, 30178, d=host-id)`. Next free slot after `KIND_MANAGED_AGENT`
(30177), same family.

```jsonc
{
  "kind": 30178,
  "pubkey": "<host_pubkey>",
  "tags": [["d", "gradient"]],
  "content": {
    "label": "gradient",
    "version": "0.1.0",
    "runtimes": [                       // the ONLY launchable set
      { "id": "claude",  "label": "Claude Code" },
      { "id": "goose",   "label": "goose" }
    ],
    "capacity": { "max_agents": 32, "deployed": 5 },
    "accepts_from": "members"           // or "allowlist"
  }
}
```

Replaceable ⇒ current state is always exactly one event. The `runtimes` list
is the capability boundary: a control frame names a runtime *id*; the host
owns the mapping from id to command line. There is no path from a remote
message to an arbitrary process.

### 4.2 `kind:24300` — control frames (ephemeral, NIP-44)

`KIND_AGENT_HOST_CONTROL`, ephemeral range (20000–29999, relay MUST NOT
persist), NIP-44 v2 content — modelled directly on kind 24200
(`KIND_AGENT_OBSERVER_FRAME`, the NIP-AO pattern), adjacent number, same
family.

```jsonc
{
  "kind": 24300,
  "pubkey": "<sender>",
  "content": "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p",     "<recipient>"],          // host for requests, owner for replies
    ["host",  "<host_pubkey>"],
    ["frame", "request" | "reply"],
    ["req",   "<uuid>"]                // correlation
  ]
}
```

Ops (plaintext, inside the ciphertext):

| Op | Payload | Effect |
|---|---|---|
| `create` | agent config: label, runtime id, system prompt, model/provider, env, timeouts | generate keypair, persist desired state, reply `{pubkey}` — not started |
| `grant` | `{agent, auth_tag}` | verify tag ↔ agent ↔ sender, write env, start |
| `configure` | `{agent, config}` | rewrite env from new config, restart if running — **this is "edit instructions from Desktop"** |
| `start` / `stop` | `{agent}` | supervise / halt the child |
| `remove` | `{agent}` | stop, delete desired state + key material |
| `status` | `{agent?}` | reply with per-agent `{state, pid?, since, restarts}` |
| `logs` | `{agent, lines}` | reply with a bounded tail |

Every mutating op requires `sender == recorded owner` (recorded at `create`).
Replies are 24300 frames encrypted to the sender, correlated by `req`.
Long-running ops reply `accepted` immediately; liveness then shows through the
agent's own presence (kind 20001) — the same two-axis status model Desktop
already uses for local agents.

Requests can carry provider API keys inside agent `env` and system prompts the
owner may consider private — hence encrypted and ephemeral even though the
*identity* secret no longer transits (§3.1). Log tails flow only in encrypted
replies to the owner.

### 4.3 Identity and idempotency

The supervision id **is the agent's pubkey**. Renaming an agent in Desktop
updates the same supervised child rather than orphaning it. `configure` is a
full-config upsert: the host rewrites the env map wholesale, so there is no
field-level drift between Desktop's record and the host's desired state.

## 5. Authorization

Checks in order, all cheap, none new:

1. **Transport** — the host and all agents connect with NIP-42; NIP-OA
   credentialed agents get virtual membership per NIP-AA, so revoking the
   owner revokes the agents' next connection automatically.
2. **Membership** — the request's `pubkey` must be a current member; the host
   verifies against the roster it already receives.
3. **Ownership** — mutating ops require the sender to be the recorded owner of
   the target agent; `grant` additionally verifies the NIP-OA auth tag via
   `buzz_sdk::nip_oa::verify_auth_tag`.
4. **Policy** — host-side `accepts_from` allowlist and per-owner quota.

**Host trust on first use** (resolved, was an open question): anyone can
publish a 30178. Desktop therefore shows the host's pubkey (npub, truncated
fingerprint) the first time a host is selected and requires explicit
acceptance; accepted host pubkeys persist in the managed-agents store, and a
changed pubkey under a reused label re-prompts. With host-generated keys the
worst case of accepting a rogue host is bounded: it runs the agents you place
on it — it never receives a secret.

## 6. Security summary

### 6.1 Removed relative to SSH-based remote execution
- No SSH keys distributed; no shell or sudo for anyone, including the daemon
- No arbitrary command execution — runtime ids only, mapped host-side
- No secret material in transit, ever (§3.1)

### 6.2 Added
A daemon that accepts network-derived commands. Mitigations: it runs
unprivileged; the op surface is eight verbs over typed payloads; env rendering
is process-API only (no shell); requests are size-bounded, quota'd, and
audit-logged with sender, op, agent, outcome.

### 6.3 Residual
A compromised owner key deploys agents as that owner (inherent to the
product). A malicious accepted host runs your agents and holds their keys —
mitigated by TOFU pinning (§5) and by NIP-OA revocation cutting those agents
off at the relay the moment the owner stops vouching.

## 7. Components

```
crates/buzz-agent-host/          the daemon (new)
  src/main.rs                    config load, relay connect, task wiring
  src/config.rs                  host id/label, runtime id → command map, policy
  src/announce.rs                build + publish kind:30178
  src/control.rs                 24300 subscribe, decrypt, dispatch, reply
  src/authz.rs                   membership + owner + auth-tag checks
  src/state.rs                   desired-state store (JSON on disk, 0600 keys)
  src/supervise.rs               child spawn/restart/backoff, env rendering, log ring
  src/reconcile.rs               startup: desired state → running children
crates/buzz-core/src/kind.rs     + KIND_AGENT_HOST_ANNOUNCE, KIND_AGENT_HOST_CONTROL
crates/buzz-sdk/src/host.rs      announce + control envelopes (builders/parsers)
desktop/src-tauri/…              BackendKind::Host, discovery, 24300 exchange
desktop/src/features/agents/…    host picker, remote runtime dropdown
```

### 7.1 Desktop integrates natively, not via a provider binary

The absorbed design routed Desktop through a `buzz-backend-host` provider
binary because it was written against an unforkable upstream. This repo *is*
upstream, so `BackendKind` gains a first-class variant:

```rust
pub enum BackendKind {
    Local,
    Provider { id: String, config: … },   // existing external seam, untouched
    Host { host_pubkey: String },          // new: relay-native
}
```

`BackendKind::Provider` already threads "this record has no local process"
through every lifecycle path (shutdown, restore, logs, runtime commands);
`Host` joins the same match arms. The `buzz-backend-*` stdio contract remains
exactly what it is today: the seam for third-party providers.

Desktop-side mechanics, all on existing rails:

- **Discovery** — query kind 30178 through the relay HTTP bridge Desktop
  already uses for event sync (`relay.rs`, reqwest). Durable kind ⇒ a plain
  query, no subscription needed.
- **Control** — build 24300 frames signed with the owner `nostr::Keys` already
  in `AppState` (the `nostr` crate is already present with the `nip44`
  feature). Because replies are ephemeral, the request/reply exchange runs
  over a short-lived WebSocket subscription via the workspace's shared
  `buzz-ws-client` — subscribe for the `req` correlation, publish, await,
  timeout. No persistent connection, no new client stack.
- **Record sync** — host-backed agents still project to kind 30177 like every
  other managed agent, so cross-device definition sync is unchanged.

## 8. What this branch deliberately does not do

- **ACP-over-WebSocket / goose.** Orthogonal and compatible: once
  `feat/acp-remote-transport` lands, a host runtime entry can map to an env
  including `BUZZ_ACP_AGENT_URL`, letting all hosted harnesses share one
  `goose serve` for provider/model/effort switching. Nothing here needs it.
- **Per-agent OS users / systemd units.** Future `Supervisor` implementation
  if isolation requirements grow (§3.2).
- **Multi-community hosts, capacity scheduling, host-to-host migration.**
  Deferred until a second real deployment exists.
- **Merging `buzz-backend-ssh`.** Superseded before it landed; it remains on
  its branch for hosts where a daemon is unwanted.

## 9. Implementation plan

Each step compiles, passes `just ci`, and leaves the tree working.

**Step 1 — kinds.** `KIND_AGENT_HOST_ANNOUNCE = 30178` and
`KIND_AGENT_HOST_CONTROL = 24300` in `buzz-core/src/kind.rs`, registered
alongside 30177 and 24200 respectively so the relay's replaceable/ephemeral
handling applies.
*Accept:* registry tests; 24300 confirmed unpersisted, 30178 confirmed
replaceable, by the existing relay semantics for their ranges.

**Step 2 — envelopes.** `buzz-sdk/src/host.rs`: announcement content types +
builder/parser; control frame envelope (NIP-44 encrypt/decrypt, tag layout,
op enum, reply types), mirroring `nip_oa.rs`'s module shape.
*Accept:* round-trip tests for every op; tamper tests (wrong recipient, bad
ciphertext, missing correlation) fail closed.

**Step 3 — daemon: announce + reconcile.** `buzz-agent-host` connects
(NIP-42, via `buzz-ws-client`), publishes 30178 from config, loads desired
state, spawns/adopts children. No control channel yet.
*Accept:* announcement visible via relay query; daemon restart is a no-op for
running agents beyond the respawn blip; kill a child, watch backoff restart.

**Step 4 — control: read-only ops.** `status` and `logs` first, so the full
auth path is exercised before anything mutates.
*Accept:* authorized `status` returns state; non-member and non-owner senders
are rejected and audit-logged.

**Step 5 — control: lifecycle ops.** `create`/`grant`/`configure`/`start`/
`stop`/`remove`, host-side key generation, env rendering into spawned
children.
*Accept:* full create → grant → mention-answer → configure(new instructions) →
restart-with-new-prompt → stop → remove cycle leaves no residue on the host.

**Step 6 — Desktop backend.** `BackendKind::Host`, discovery command, 24300
exchange, TOFU store, lifecycle routing for host-backed records (create maps
to create+grant; edit maps to configure; delete maps to remove), no nsec
stored locally.
*Accept:* Rust unit tests for routing + the structural guarantee that
host-backed records serialize without key material.

**Step 7 — Desktop UI.** "Where to run" lists discovered hosts with
fingerprint acceptance; runtime dropdown for a host-backed agent comes from
that host's announcement; instance editing works unchanged; logs viewer reads
via the `logs` op.
*Accept:* create an agent on a host from the dialog; close the laptop lid;
the agent answers an `@mention`; reopen, edit its instructions, it answers
with the new behavior.

**Step 8 — hardening.** Quotas, allowlist, request size bounds, audit trail;
parity test that a host-backed and local agent behave identically from the
relay's perspective.

## 10. Open questions (carried, non-blocking)

1. **Multi-operator capacity** — when several members share one host, whether
   `capacity` should gate `create` host-side only or also grey out the host in
   Desktop. Host-side enforcement ships first; UI affordance later.
2. **Log streaming** — `logs` is a bounded pull. If continuous streaming is
   wanted later, kind 24200 observer frames are the natural rail (the agent
   already publishes them); do not add a new mechanism.
3. **Host announcement scoping** — whether 30178 should carry an `h` tag to
   scope announcements to a channel, or stay community-global. Ships global;
   NIP-29 scoping is additive.
