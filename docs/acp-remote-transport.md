# Remote ACP transport — one `goose serve`, many providers

**Status:** design, not yet implemented
**Branch:** `feat/acp-remote-transport`
**Verified against:** `kbst9/buzz` @ `37420764`, goose `1.44.0`
**Related:** [remote-runtime-agents.md](remote-runtime-agents.md) · [remote-agent-host.md](remote-agent-host.md)

---

## 1. Summary

Teach `buzz-acp` to dial an ACP endpoint over WebSocket instead of spawning a
local child. Point it at a `goose serve` on the always-on host. goose fronts
Claude, Codex, Grok and others through **your existing subscriptions**, and the
provider, model, and thinking effort are selected **per session over ACP**.

This is the smallest change that gives Desktop-configured remote execution — one
new transport in one crate, no backend provider, no daemon, no fork of the
desktop app.

## 2. What was verified (not assumed)

Everything below was tested against goose 1.44.0 on `gradient-ssh`.

**ACP works over WebSocket.** Using `tokio-tungstenite` — the client stack
`buzz-acp` already links for the relay — against `goose serve`:

```
handshake: HTTP 101 Switching Protocols
--> initialize
<-- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,…,
     "agentInfo":{"name":"goose","version":"1.44.0"}}}
```

Reproduce with `cargo run -p buzz-acp --example acp_ws_probe -- <url> <secret>`.

**Endpoint shape.** `/acp` is the WebSocket route — `401` unauthenticated, `406`
without an upgrade. Auth is the `X-Secret-Key` header backed by
`GOOSE_SERVER__SECRET_KEY`. `/health` and `/status` are unauthenticated. Defaults
bind `127.0.0.1:3284`; `--tls` available; `--dangerously-unauthenticated` exists
and should never be used.

**goose reuses already-authenticated CLIs.** Provider ids ending `-acp` shell out
to an authenticated CLI rather than taking an API key. End-to-end on the server:

```
● new session · claude-acp current  →  GOOSE_VIA_CLAUDE_OK   (Claude Max)
● new session · codex-acp  current  →  GOOSE_VIA_CODEX_OK    (ChatGPT Plus/Pro)
```

**Env vars alone configure it.** With `~/.config/goose/config.yaml` removed,
`GOOSE_PROVIDER=claude-acp GOOSE_MODEL=current` works. No config file, no
`*_configured` flag.

### 2.1 The correction: you do **not** need one `goose serve` per provider

`session/new` returns provider as a **per-session config option**:

```
modes   : [auto, approve, smart_approve, chat]   current: auto
option 'provider'        type=select  current='claude-acp'  count=71
   subscription-backed: amp-acp, claude-acp, codex-acp, copilot-acp,
                        cursor-agent, gemini_oauth, pi-acp, xai_oauth
option 'model'           type=select  current='current'     count=6
option 'mode'            type=select  current='auto'        count=4
option 'thinking_effort' type=select  current='off'
```

**One instance serves all 71 providers**, switched per session via
`session/set_config_option` — a request `buzz-acp` already implements
(`acp.rs:622`). So the topology is one unit, one port, one endpoint to discover.

Two consequences worth noting:

- `xai_oauth` is *"xAI (SuperGrok Subscription)… OAuth instead of an API key.
  Falls back to a device-code flow on headless / remote machines"* — Grok on a
  subscription, answering the original question that started this work.
- `thinking_effort` is a session config option. Effort **cannot** cross the host
  boundary in the deploy-payload design (it isn't in the payload at all), but it
  *can* here, because ACP carries it. This route closes the effort gap.

## 3. Architecture

```
    Mac                                        gradient-ssh
┌─────────────┐                            ┌────────────────────────┐
│ Buzz Desktop│ spawns                     │  goose serve (one)     │
│   └─ buzz-acp ──── wss + X-Secret-Key ──▶│    /acp                │
└─────────────┘                            │      ├ claude-acp ─▶ claude CLI (Max)
       │ relay ws                          │      ├ codex-acp  ─▶ codex CLI (ChatGPT)
       ▼                                   │      └ xai_oauth  ─▶ SuperGrok
   buzz relay                              └────────────────────────┘
```

`buzz-acp` still runs where Desktop spawns it. **Execution and inference move;
liveness does not** — close the laptop and the agent stops answering. That limit
is inherent to every "Desktop configures it" design and is why the systemd agents
already running on the host remain the answer for always-on work.

## 4. Changes to `buzz-acp`

### 4.1 `BUZZ_ACP_AGENT_URL` — the transport

Today `AcpClient::spawn` builds a `tokio::process::Command`, pipes stdin/stdout,
and uses `process_group(0)` so the tree can be killed. The new path swaps those
pipes for a socket:

```rust
#[arg(long, env = "BUZZ_ACP_AGENT_URL", conflicts_with = "agent_command")]
pub agent_url: Option<String>,

#[arg(long, env = "BUZZ_ACP_AGENT_SECRET")]   // sent as X-Secret-Key
pub agent_secret: Option<String>,
```

The JSON-RPC framing layer above is unchanged — it already reads and writes
newline-delimited JSON objects. Only the byte source differs, so `session/new`,
`session/prompt`, `session/update`, `session/cancel` and the permission flow all
work untouched.

Deliberate design points:

- **`conflicts_with`** — a URL and a command are mutually exclusive. Silently
  preferring one would make misconfiguration invisible.
- **No process-group kill.** Cancellation becomes `session/cancel` plus closing
  the socket. The existing `kill_process_group` path must be skipped, not called
  with a bogus pid.
- **Reconnect.** A dropped socket must not be a dead agent. Reconnect with
  bounded backoff and surface the state, mirroring how the relay connection
  already behaves.
- **Idle timeout** (`BUZZ_ACP_IDLE_TIMEOUT`, default 620s) currently resets on
  agent stdout activity; it should reset on inbound frames instead.

### 4.2 `BUZZ_ACP_CONFIG_OPTIONS` — provider, effort, mode

`buzz-acp` can already set the **model** config option (`BUZZ_ACP_MODEL`,
`extract_model_config_options`). goose exposes three more — `provider`,
`mode`, `thinking_effort` — through the same `session/set_config_option` request.

A small generalization covers all of them:

```
BUZZ_ACP_CONFIG_OPTIONS=provider=claude-acp,thinking_effort=high
```

Applied after `session/new`, validated against the `configOptions` that session
actually advertised, with a clear error naming the valid values when one is
unknown. This is how a Desktop persona chooses Claude vs Codex vs Grok on a
remote goose.

## 5. Discovery and registration

The question you asked, and it gets much easier now that it is **one endpoint per
host** rather than one per provider. Three tiers, each usable alone.

### Tier 1 — static URL (no infrastructure)

Set on a persona or agent in Desktop:

```
BUZZ_ACP_AGENT_URL    = wss://goose.gradientcm.com/acp
BUZZ_ACP_AGENT_SECRET = <shared secret>
BUZZ_ACP_CONFIG_OPTIONS = provider=claude-acp
```

Desktop merges global < persona < agent env vars into what the harness receives,
so this works today with no code beyond §4. Good enough for one operator.

### Tier 2 — relay announcement (recommended for more than one person)

A host publishes a **replaceable, secret-free** event listing its endpoints:

```jsonc
{ "kind": 30178, "tags": [["d","gradient"]],
  "content": { "label": "gradient",
               "endpoints": [{ "id":"goose", "url":"wss://goose.gradientcm.com/acp",
                               "kind":"acp", "providers":["claude-acp","codex-acp","xai_oauth"] }] } }
```

The elegant part: **`buzz-acp` is already connected to the relay with its own
identity**, so it can resolve a logical name — `BUZZ_ACP_AGENT_URL=buzz://gradient/goose`
— by querying for the announcement. No new client, no new credential, no separate
discovery service. Membership is the gate, exactly as everywhere else in Buzz.

This is the same `kind:30178` proposed in [remote-agent-host.md](remote-agent-host.md),
but carrying only endpoints rather than deployment capability — a much smaller
thing to specify and to trust.

### Tier 3 — the catalog (upstream)

Announcements feed `runtimes: [...]` on `AcpRuntimeCatalogEntry`, so Desktop's own
runtime dropdown shows `claude (gradient)` beside `claude (this computer)`. Only
this tier makes the UI *honest* about where an agent runs; Tiers 1 and 2 work
while the dropdown still describes the local machine. Requires the Rust catalog
change — `AGENTS.md` forbids a TypeScript shim.

## 6. Exposing the endpoint

`goose serve` binds `127.0.0.1` by default — keep it that way. The harness on the
Mac needs network reach, so pick one:

| Option | Auth | Notes |
|---|---|---|
| cloudflared public hostname | `X-Secret-Key` only | Simplest; a shared secret is the *only* gate. Weaker than the relay's nostr auth |
| cloudflared + Access service token | Access **and** secret | Harness must send `CF-Access-Client-Id/Secret`; it is a plain HTTP client, so it can |
| SSH tunnel | SSH | No new exposure; requires a tunnel to be up |

Do not use `--dangerously-unauthenticated`. Do not bind `0.0.0.0` — recall that
Docker's published ports already bypass ufw on this host, so "the firewall will
catch it" is not a safe assumption.

## 7. Implementation steps

**Step 1 — transport.** `BUZZ_ACP_AGENT_URL` + `BUZZ_ACP_AGENT_SECRET`, with the
framing layer untouched. Skip process-group kill on the URL path.
*Accept:* the existing `acp_ws_probe` handshake, driven through `AcpClient`
rather than the example.

**Step 2 — transport parity tests.** Run the existing ACP test suite against both
a spawned child and a socket, so neither path can regress alone.
*Accept:* same assertions pass for both transports.

**Step 3 — reconnect and cancellation.** Backoff on drop; `session/cancel` plus
socket close replaces killing a process tree.
*Accept:* killing `goose serve` mid-turn surfaces a clean error and recovers on
restart, rather than hanging until the idle timeout.

**Step 4 — `BUZZ_ACP_CONFIG_OPTIONS`.** Generalize beyond model; validate against
the session's advertised options.
*Accept:* one goose endpoint runs a Claude agent and a Codex agent concurrently,
distinguished only by config options.

**Step 5 — host unit.** A single `goose serve` systemd unit, loopback-bound, with
a secret from an `EnvironmentFile`, plus the chosen exposure from §6.
*Accept:* survives reboot; `/health` reachable through the tunnel.

**Step 6 — Tier 2 discovery.** Announcement publisher plus `buzz://host/endpoint`
resolution inside the harness.
*Accept:* an agent configured with a logical name deploys with no URL anywhere in
its config.

## 8. Limits and risks

- **No always-on.** The harness lives with Desktop. This design moves execution,
  never liveness.
- **Three hops.** `buzz-acp → goose → claude-agent-acp → claude`. Each adds
  latency and a failure mode, and `GOOSE_MODEL: current` defers real model choice
  to the inner adapter — you are selecting a provider more than a model.
- **Shared-secret auth** is weaker than the nostr authorization used everywhere
  else in Buzz. Tier 2 discovery does not fix this; only Access service tokens or
  a nostr-authenticated endpoint would.
- **Adapter package drift.** goose's help says `@zed-industries/codex-acp`; this
  host has `@agentclientprotocol/codex-acp`. Same binary name, two orgs — a
  future install could shadow the other.
- **Only goose serves ACP over a network.** `claude-agent-acp`, `codex-acp` and
  `hermes acp` are stdio-only, so goose is doing real work here as a multiplexer,
  not merely a passthrough.
