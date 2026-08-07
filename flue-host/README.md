# buzz-flue-host — `flue-acp`

The ACP agent command that lets unmodified **buzz-acp** drive a
[Flue](https://flueframework.com) agent. This is the default execution tier
from [AGENTOS_HOST_PLAN.md](../AGENTOS_HOST_PLAN.md): the harness runs
**host-side** (topology T2 — model calls and credentials never enter the
sandbox), and the agent's tools execute in a Flue sandbox rooted in the
session workspace.

```
buzz-acp (Rust, unmodified)
   │  ACP over stdio (NDJSON, protocolVersion 2)
   ▼
flue-acp (this package)                        ← BUZZ_ACP_AGENT_COMMAND
   │  @flue/runtime in-process: start() / init() / dispatch / read(onEvent)
   ▼
Flue agent (one instance per ACP session)
   ├─ model: BUZZ_FLUE_MODEL via pi providers (credentials host-side)
   └─ sandbox: local(cwd = session/new.cwd) → bash, read, write, edit, grep, glob
      env: BUZZ_* auth only — the `buzz` CLI works, host secrets stay out
```

## Build

```bash
. ../bin/activate-hermit         # node >= 22.19 + pnpm
CI=true pnpm install
pnpm build                       # emits dist/ (bin: dist/main.js)
pnpm test                        # 14 tests incl. the golden ACP transcript
```

## Wiring an agent unit

`flue-acp` slots into the existing standalone-unit model
([docs/standalone-agents.md](../docs/standalone-agents.md)) by changing two
lines of the unit's env file — everything else (keys, invite claim, relay)
stays as provisioned:

```ini
# /etc/buzz-agents/<name>.env
BUZZ_ACP_AGENT_COMMAND=/usr/local/lib/buzz-flue-host/dist/main.js
BUZZ_ACP_AGENT_ARGS=
BUZZ_FLUE_MODEL=xai/grok-4.5
# Provider credential, resolved host-side by the pi provider layer:
XAI_API_KEY=...
```

Deploy the package once per host:

```bash
sudo mkdir -p /usr/local/lib/buzz-flue-host
sudo rsync -a --delete package.json pnpm-lock.yaml pnpm-workspace.yaml dist node_modules /usr/local/lib/buzz-flue-host/
sudo chmod 0755 /usr/local/lib/buzz-flue-host/dist/main.js
```

Rollback is the same two env lines reverted plus a unit restart.

### Environment contract

| Var | Required | Meaning |
|---|---|---|
| `BUZZ_FLUE_MODEL` | yes | Flue model specifier, `provider/model`, resolved against pi-ai's catalog — e.g. `xai/grok-4.5`, `openai-codex/gpt-5.5`, `anthropic/claude-sonnet-4-6` |
| `BUZZ_FLUE_DB` | no | SQLite path for Flue persistence (default `:memory:`, matching buzz-acp's session lifecycle — it never reattaches sessions across respawns) |
| `BUZZ_FLUE_LOG` | no | stderr log level: `debug`\|`info`\|`warn`\|`error` |
| provider keys | per model | `XAI_API_KEY`, `OPENAI_API_KEY`, … — resolved host-side; **never forwarded into the sandbox** |

The sandbox env is allowlisted, not inherited: `BUZZ_RELAY_URL`,
`BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`, `BUZZ_ACP_DISPLAY_NAME` (from the
process env and/or the `session/new.mcpServers` declarations) — exactly what
the `buzz` CLI needs to authenticate, and nothing else. This is a tighter
posture than the previous adapters, which inherited the full unit
environment into every shell.

## Fleet provisioning (`fleet.toml`)

One multi-use agent invite plus one declarative file provisions N agents
with zero per-agent ceremony:

1. Mint the invite in the desktop: Settings → Connected agents → Add agent →
   fleet mint with a uses budget ≥ the fleet size. Every claimant is
   attributed to the minting owner; the budget and expiry bound a leaked
   code's blast radius.
2. Copy [`fleet.toml.example`](fleet.toml.example) to `fleet.toml` and add
   one `[[agents]]` entry per agent (name, model, optional respond_to /
   display_name).
3. On the host:

```bash
sudo -v && pnpm exec tsx scripts/provision-fleet.ts            # or --dry-run first
```

Each entry becomes `/etc/buzz-agents/<name>.env` + a
`buzz-acp-<name>.service` unit (same shape as
`scripts/new-standalone-agent.sh` in the repo root — fleet and
hand-provisioned units stay interchangeable), with the keypair generated
host-side. A shared `provider_env` file joins every unit via a systemd
drop-in, so provider keys stay out of per-agent env files. Re-runs skip
entries whose env file exists: growing the fleet is "add an entry, run
again". Config parsing and file rendering live in `src/fleet/` with golden
tests in `test/fleet.test.ts`.

## What v1 deliberately does not do

- **Spawn stdio MCP servers.** Flue's transports are HTTP-only, and its
  native sandbox toolset covers `buzz-dev-mcp`'s surface. Declared servers
  are logged and their env forwarded to the sandbox; the Buzz surface is the
  `buzz` CLI.
- **Steering.** `_meta.steering.supported` is not advertised;
  `_session/steering` gets `-32601` and buzz-acp falls back to
  cancel-and-merge, per contract.
- **Usage metrics.** The optional `usage_update` notification (turn-metric
  kind 44200 upstream) is a follow-up.
- **agentOS sandboxes.** v1 uses Flue's `local()` sandbox — same-host
  execution with an explicit env allowlist. The isolation tier
  (`@rivet-dev/agentos` or containers) layers in behind the same
  `useSandbox` seam without touching this adapter; the dependency is
  deliberately not carried until then.

## Protocol

The ACP dialect (buzz's `protocolVersion: 2` squat) is transcribed in
[`src/acp/protocol.ts`](src/acp/protocol.ts) from `crates/buzz-acp/src/acp.rs`
and `crates/buzz-agent`. The load-bearing choices, each pinned by a test:

- stdout is exclusively NDJSON frames; all logging goes to stderr.
- `session/new.systemPrompt` is always applied (dropping it silently loses
  the persona).
- After `session/cancel`, the in-flight `session/prompt` is still answered —
  `{"stopReason":"cancelled"}` — otherwise buzz-acp SIGKILLs the process
  group.
- Unknown methods get `-32601`, never `{}` (a success reply to
  `_session/steering` would make buzz-acp silently drop a user message).
- Keepalives tick every 30s mid-turn against buzz-acp's 900s idle clock.
