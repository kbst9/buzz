# Remote ACP transport — one `goose serve`, many providers

**Status:** design, ready to implement
**Branch:** `feat/acp-remote-transport`
**Verified against:** `kbst9/buzz` @ `37420764`, goose `1.44.0`
**Related:** [remote-runtime-agents.md](remote-runtime-agents.md) · [remote-agent-host.md](remote-agent-host.md)

---

## 1. Summary

Teach `buzz-acp` to dial an ACP endpoint over WebSocket instead of spawning a
local child, and point it at one `goose serve` on the always-on host. goose fronts
Claude, Codex and Grok through **existing subscriptions**, with provider, model,
mode and thinking effort selected **per session over ACP**.

The only code change anywhere is a transport in `buzz-acp`. The agent-config
dropdown entry — literally `Claude (gradient)` — needs **no code at all**: Buzz
already loads user-defined runtimes from JSON (§6).

## 2. What was verified

Tested against goose 1.44.0 on `gradient-ssh`, not assumed.

**ACP works over WebSocket**, using `tokio-tungstenite` — the stack `buzz-acp`
already links for the relay:

```
handshake: HTTP 101 Switching Protocols
--> initialize
<-- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,…,
     "agentInfo":{"name":"goose","version":"1.44.0"}}}
```

Reproduce: `cargo run -p buzz-acp --example acp_ws_probe -- <url> <secret>`.

**Endpoint shape.** `/acp` is the WebSocket route — `401` unauthenticated, `406`
without an upgrade. Auth is `X-Secret-Key` backed by `GOOSE_SERVER__SECRET_KEY`.
`/health` and `/status` are unauthenticated. Defaults bind `127.0.0.1:3284`.

**goose reuses authenticated CLIs.** End-to-end, no API keys:

```
● new session · claude-acp current  →  GOOSE_VIA_CLAUDE_OK   (Claude Max)
● new session · codex-acp  current  →  GOOSE_VIA_CODEX_OK    (ChatGPT Plus/Pro)
```

**Env vars alone configure it** — with `config.yaml` deleted,
`GOOSE_PROVIDER=claude-acp GOOSE_MODEL=current` works.

### 2.1 One instance, not one per provider

`session/new` advertises provider as a per-session config option:

```
modes   : [auto, approve, smart_approve, chat]   current: auto
option 'provider'        select  current='claude-acp'  count=71
   subscription-backed: amp-acp, claude-acp, codex-acp, copilot-acp,
                        cursor-agent, gemini_oauth, pi-acp, xai_oauth
option 'model'           select  current='current'     count=6
option 'mode'            select  current='auto'        count=4
option 'thinking_effort' select  current='off'
```

A single instance switches provider per session via `session/set_config_option`,
which `buzz-acp` already implements (`acp.rs:622`). One unit, one port, one
endpoint.

`xai_oauth` is *"xAI (SuperGrok Subscription)… OAuth instead of an API key.
Falls back to a device-code flow on headless / remote machines."*

`thinking_effort` being a session option matters: effort is **absent from the
deploy payload entirely**, so the provider/daemon designs cannot carry it. ACP can.

## 3. Architecture — one goose, two harness lifecycles

```
                          gradient-ssh
                    ┌──────────────────────────────────────┐
                    │  goose serve  (one, 127.0.0.1:3284)  │
                    │    ├ claude-acp ─▶ claude CLI (Max)  │
                    │    ├ codex-acp  ─▶ codex CLI (ChatGPT)│
                    │    └ xai_oauth  ─▶ SuperGrok         │
                    └──────┬─────────────────────┬─────────┘
       ws://127.0.0.1:3284 │                     │ via Access tunnel
                    ┌──────▼───────┐      ┌──────▼──────────────┐
                    │ systemd      │      │ Desktop-spawned     │
                    │ buzz-acp ×N  │      │ buzz-acp            │
                    │ ALWAYS ON    │      │ interactive         │
                    └──────────────┘      └─────────────────────┘
```

Two classes of agent with honestly different lifecycles, sharing one execution
layer. The systemd harnesses already running on the host keep answering when the
laptop is shut; Desktop-spawned ones do not. That is not a compromise to fix —
it is the distinction made explicit, and it lets the existing five agents move
onto goose and gain provider/effort switching.

## 4. Changes to `buzz-acp`

### 4.1 `BUZZ_ACP_AGENT_URL` — the transport

```rust
/// When set, connect to this ACP endpoint instead of spawning a child.
/// Takes precedence over `--agent-command`.
#[arg(long, env = "BUZZ_ACP_AGENT_URL")]
pub agent_url: Option<String>,

/// Sent as the `X-Secret-Key` header.
#[arg(long, env = "BUZZ_ACP_AGENT_SECRET")]
pub agent_secret: Option<String>,
```

**The URL must *override* the command, not conflict with it.** A `conflicts_with`
would be the obvious choice and is wrong: Desktop always sets
`BUZZ_ACP_AGENT_COMMAND` from the runtime catalog, so a conflict would make every
Desktop-launched agent fail. Precedence with a log line at startup is correct.

The JSON-RPC framing above the transport is unchanged — it already reads and
writes newline-delimited JSON objects, so `session/new`, `session/prompt`,
`session/update`, `session/cancel` and the permission flow are untouched.

Three things that are **not** just a pipe swap:

- **Cancellation.** `kill_process_group` has no meaning here. Cancel becomes
  `session/cancel` plus closing the socket; the kill path must be skipped, not
  called with a fabricated pid.
- **Reconnect.** A dropped socket must not read as a dead agent. Bounded backoff,
  mirroring the relay connection's existing behaviour.
- **Idle timeout.** `BUZZ_ACP_IDLE_TIMEOUT` (default 620s) currently resets on
  child stdout activity; it must reset on inbound frames.

### 4.2 `BUZZ_ACP_CONFIG_OPTIONS` — provider, effort, mode

`buzz-acp` can already set the **model** option (`BUZZ_ACP_MODEL`,
`extract_model_config_options`). goose exposes three more through the same
request. Generalize:

```
BUZZ_ACP_CONFIG_OPTIONS=provider=claude-acp,thinking_effort=high
```

Applied after `session/new`, validated against the options that session actually
advertised, erroring with the valid values when one is unknown.

## 5. Exposure — reuse Cloudflare Access

**This design has no SSH dependency.** The protocol is WebSocket + JSON-RPC end to
end. Three layers are easy to conflate:

| Layer | SSH? |
|---|---|
| `buzz-acp` ↔ goose protocol | No — WebSocket only |
| Reachability from the Mac | A tunnel is needed; SSH is one option and not the recommended one |
| Always-on harnesses on the host | No tunnel at all — `ws://127.0.0.1:3284/acp`, same machine |

Contrast [buzz-backend-ssh](../crates/buzz-backend-ssh/README.md), which genuinely
depends on SSH: it pipes a shell script over `ssh` and needs passwordless sudo on
the target. Nothing here does, which is why revoking a teammate is an Access
policy change rather than an `authorized_keys` edit.

`goose serve` binds loopback by default. **Keep it there and never publish it.**
Reuse the mechanism the SSH config already uses (`ProxyCommand cloudflared access ssh`),
in its TCP form:

```bash
# on the Mac — Access-authenticated local port, no SSH
cloudflared access tcp --hostname goose.gradientcm.com --url 127.0.0.1:13284
```

`cloudflared access tcp` is confirmed present in the installed cloudflared
(`tcp, rdp, ssh, smb` share one command). The `ws://127.0.0.1:13284/acp` used
throughout this doc is the near end of that tunnel.

| Option | Gate | Verdict |
|---|---|---|
| `cloudflared access` on the Mac → host loopback | Access identity, then goose secret | **Recommended.** No public hostname, no new ingress; goose's secret is defence in depth |
| Public hostname + `CF-Access-Client-Id/Secret` from the harness | Access service token + secret | Works, no sidecar, but goose is internet-facing |
| Public hostname, secret only | shared secret | Rejected — one string between the internet and your subscriptions |

Never `--dangerously-unauthenticated`. Never bind `0.0.0.0`: on this host Docker's
published ports already bypass ufw, so "the firewall will catch it" is unsafe.

A NIP-98-validating reverse proxy would make authorization nostr like everything
else in Buzz. Rejected for now: new privileged code guarding your subscriptions,
to replace a mechanism you already operate.

### 5.1 Pin the adapter paths

goose honours per-adapter command overrides — `CLAUDE_CODE_COMMAND`,
`CODEX_COMMAND`, `CURSOR_AGENT_COMMAND`, `GEMINI_CLI_COMMAND`. Set absolute paths
in the unit so the `@zed-industries` vs `@agentclientprotocol` package ambiguity
cannot bite.

## 6. The UI: `Claude (gradient)` with no code

`custom_harnesses.rs` is a loader for **user-defined ACP runtimes**: *"Users drop
JSON files into `<app-data>/custom_harnesses/` to register arbitrary ACP-speaking
agents without modifying the app or opening a PR."*

`HarnessDefinition` is `{ id, label, command, args, env, install_instructions_url,
install_hint }`, and **`env` is injected at spawn time on the harness process** —
which is exactly what reads `BUZZ_ACP_AGENT_URL`. So one file per remote provider:

```json
{
  "id": "claude-gradient",
  "label": "Claude (gradient)",
  "command": "true",
  "env": {
    "BUZZ_ACP_AGENT_URL": "ws://127.0.0.1:13284/acp",
    "BUZZ_ACP_AGENT_SECRET": "…",
    "BUZZ_ACP_CONFIG_OPTIONS": "provider=claude-acp"
  },
  "install_hint": "Requires the Access tunnel to gradient-ssh to be up."
}
```

Drop in `codex-gradient.json` and `grok-gradient.json` alongside, and the runtime
dropdown reads:

```
Claude Code            (this computer)
Claude (gradient)
Codex (gradient)
Grok (gradient)
```

Personas pin them, teams contain them, and everything downstream behaves normally
because these are ordinary managed agents.

Constraints, from the loader's own rules:

- **`command` is vestigial** under a URL transport but must be non-empty and is
  probed locally for availability. `"true"` satisfies the probe honestly enough;
  leaving a real name shows *unavailable*, which you said is acceptable.
- **No id collisions with built-ins** — `check_id_collision` rejects `claude`,
  `goose`, etc. Hence `claude-gradient`.
- **No custom avatars and no auto-install**, both deliberate security choices in
  the loader. Custom entries get a generic icon.
- Definition `env` **loses** to Buzz-injected vars, so it cannot hijack
  `BUZZ_PRIVATE_KEY` or `BUZZ_MANAGED_AGENT`.

This is the significant find: it makes upstream catalog work **optional**, not a
prerequisite. The label carries the host, so the dropdown stops lying without
touching `AcpRuntimeCatalogEntry`.

## 7. Implementation plan

### Step 0 — host: one `goose serve` unit
`/etc/systemd/system/goose-serve.service`, `User=` a dedicated account,
`--host 127.0.0.1 --port 3284`, `EnvironmentFile` holding
`GOOSE_SERVER__SECRET_KEY`, plus `GOOSE_PROVIDER`/`GOOSE_MODEL` defaults and the
pinned `*_COMMAND` paths from §5.1.
*Accept:* survives reboot; `/health` 200 on loopback; `/acp` 401 without the key.

### Step 1 — `buzz-acp`: transport
`config.rs` gains `agent_url`/`agent_secret`; `acp.rs` gains a connect path
alongside spawn. URL takes precedence over command, logged at startup.
*Accept:* `AcpClient` completes `initialize` against `goose serve` — the probe's
handshake, driven through the real client rather than the example.

### Step 2 — parity tests
Run the existing ACP suite against both transports so neither can regress alone.
*Accept:* identical assertions pass for spawned-child and socket.

### Step 3 — cancellation, reconnect, idle timeout
`session/cancel` + close replaces process-group kill; bounded backoff on drop;
idle timer resets on inbound frames.
*Accept:* killing `goose serve` mid-turn yields a clean error and recovery on
restart, instead of hanging to the idle timeout.

### Step 4 — `BUZZ_ACP_CONFIG_OPTIONS`
Generalize beyond model; validate against the session's advertised options.
*Accept:* two agents on one endpoint, one Claude and one Codex, differing only in
config options.

### Step 5 — Mac: Access sidecar + custom harnesses
`cloudflared access tcp --hostname goose.gradientcm.com --url 127.0.0.1:13284`
(no SSH), plus one JSON per remote provider in `<app-data>/custom_harnesses/`.
Requires a Cloudflare public hostname for goose with an Access policy on it —
the tunnel terminates at the host's loopback, so goose itself stays unpublished.
*Accept:* `Claude (gradient)` appears in the runtime dropdown; an agent created on
it answers an `@mention`; the work happens on the server.

### Step 6 — migrate the existing five (optional)
Point the systemd harnesses at `ws://127.0.0.1:3284/acp` with
`BUZZ_ACP_CONFIG_OPTIONS=provider=…`, gaining provider and effort switching while
staying always-on.
*Accept:* each still answers, now with effort configurable.

### Step 7 — relay discovery (optional, for more than one operator)
Host publishes a replaceable, secret-free endpoint announcement; `buzz-acp`
resolves `buzz://gradient/goose` over the relay connection **it already has**, so
no new client or credential. Replaces hand-written URLs in the JSON files.
*Accept:* an agent configured with a logical name runs with no URL in its config.

## 8. Limits

- **No always-on for Desktop-spawned agents.** Structural, addressed by the
  two-lifecycle split rather than solved.
- **Three hops** — `buzz-acp → goose → claude-agent-acp → claude`. Reframed: goose
  *is* the ACP gateway you would otherwise write, since the other adapters are
  stdio-only. The hop buys the network transport, 71 providers, and effort.
- **`GOOSE_MODEL: current`** defers real model choice to the inner adapter, so you
  are selecting a provider more than a model.
- **Shared-secret auth** remains goose's own mechanism; Access is what makes it
  acceptable, not the secret itself.
