# Remote-runtime agents, configurable from Buzz Desktop

**Status:** design / implementation plan
**Written:** 2026-07-26
**Verified against:** `block/buzz` @ `acfbb1bb` (desktop v0.4.23 line); `:main` had moved to `1a56b7cc` the same day.

> Every claim below carries a `file:line` citation. Re-verify before starting —
> this rests on an interface with **no documentation, no CHANGELOG entry, and no
> preview-feature flag**, in a repo that ships several times a week.

---

## 1. Problem

Agents that execute on `gradient-ssh` cannot be created or configured from Buzz
Desktop. The consequence chain:

```
runtime      ← discovered by probing the LOCAL PATH only
   ↓
persona      kind:30175, owner-authored — pins a runtime
   ↓
agent        locally spawned, or "Run on" a backend provider
   ↓
team         kind:30176, content = { name, description, instructions, persona_ids }
```

Teams key on `persona_ids`; a persona pins a runtime; runtime availability is
computed against the local machine. No remote runtime → no persona → no team
membership → no multi-agent coordination.

**Goal:** create, configure, and group agents from Desktop while execution
happens on the always-on server.

---

## 2. What already exists (the path of least resistance)

This is the important part. Far more is built than is visible, because
`WhereToRunSection` renders nothing when no provider binary is on PATH
(`desktop/src/features/agents/ui/WhereToRunSection.tsx:66`).

> **Verified in the shipped binary.** `strings` on the installed
> `/Applications/Buzz.app/Contents/MacOS/buzz-desktop` (v0.4.23) contains
> `provider 'buzz-backend-` and `' is not a discovered buzz-backend-* provider`
> — the anti-arbitrary-exec guard from `agent_providers.rs:32`. The section is
> rendered unconditionally from `AgentDialog.tsx:124`; the only gate is
> `backendProviders.length === 0` inside the component. No preview flag, no
> Cargo feature. **Phase 1 therefore requires no Desktop change at all** —
> dropping a `buzz-backend-ssh` binary on PATH makes "Run on" appear in the
> app you already have installed.

### 2.1 Provider backends are a first-class, persisted concept

```rust
pub enum BackendKind { Local, Provider { id: String, config: serde_json::Value } }
```
`desktop/src-tauri/src/managed_agents/types.rs:6`, with `backend` and
`backend_agent_id` persisted on the agent record (`types.rs:294,296`).

Already implemented against it:

| Capability | Location |
|---|---|
| Discovery of `buzz-backend-*` on PATH, exe dir, `~/.local/bin` | `managed_agents/backend.rs:419` |
| `op:info` probe with anti-arbitrary-exec check | `commands/agent_providers.rs:19` |
| `op:deploy` + persistence of `backend_agent_id` / `last_error` | `commands/agents.rs:460` |
| Binary resolution hardened against record tampering | `commands/agents.rs:473` |
| Provider agents excluded from local autostart | `runtime_commands.rs:471`, `restore.rs:171` |
| Provider agents excluded from local process cleanup | `runtime.rs:1221` |
| Provider agents excluded from local shutdown | `shutdown.rs:157` |
| Two-axis status model for remote agents | `runtime.rs:1389` |
| `provider_config` validation (flat, ≤20 fields, ≤64KB, secret-key rejection) | `backend.rs:380` |
| "Run on" UI + private-key warning | `WhereToRunSection.tsx` |

### 2.2 The two-axis status model already solves most of "lifecycle"

From `runtime.rs:1389`:

- **Control plane** — `deployed` once the provider returns a `backend_agent_id`;
  `not_deployed` otherwise. Tracks whether infrastructure *exists*.
- **Live axis** — relay presence (online/away/offline), polled by the frontend,
  rendered as a `PresenceDot`.

The harness already publishes presence (`buzz-acp` logs `presence set to online`),
so a remote agent reports liveness **through the relay** with no extra protocol.
There is no need for an `op:status`.

### 2.3 The deploy payload is the whole Phase 1 spec

`commands/agents_deploy.rs:112` — *"every field the provider harness receives is
deliberately listed here"*:

```json
{
  "name", "relay_url", "private_key_nsec", "auth_tag",
  "agent_command", "agent_args", "system_prompt",
  "model", "provider",
  "turn_timeout_seconds", "idle_timeout_seconds", "max_turn_duration_seconds",
  "parallelism",
  "respond_to", "respond_to_allowlist",
  "env_vars"
}
```

Env layering (global < persona < agent) is resolved **before** serialization
(`agents_deploy.rs:77-85`), and deploy fails closed if the private key is
unavailable (`agents_deploy.rs:68`). `auth_tag` means Desktop mints the NIP-OA
attestation and hands it over — the provider only plumbs it.

### 2.4 Every field maps onto the manual deployment already running

| Payload field | Manual equivalent on `gradient-ssh` |
|---|---|
| `private_key_nsec` | `BUZZ_PRIVATE_KEY` in `/etc/buzz-agents/<id>.env` |
| `auth_tag` | `BUZZ_AUTH_TAG` (NIP-OA attestation) |
| `relay_url` | `BUZZ_RELAY_URL` |
| `agent_command` / `agent_args` | `BUZZ_ACP_AGENT_COMMAND` / `BUZZ_ACP_AGENT_ARGS` |
| `system_prompt` | `BUZZ_ACP_SYSTEM_PROMPT_FILE` → `/usr/local/share/buzz-agents/prompts/<id>.md` |
| `parallelism` | `BUZZ_ACP_AGENTS` |
| `idle_timeout_seconds` / `max_turn_duration_seconds` | `BUZZ_ACP_IDLE_TIMEOUT` / `BUZZ_ACP_MAX_TURN_DURATION` |
| `respond_to` / `respond_to_allowlist` | `--respond-to` / `--respond-to-allowlist` |
| `model` / `provider` | runtime-specific env (`KnownAcpRuntime.model_env_var` / `provider_env_var`) |
| `env_vars` | extra `Environment=` lines |

**The five hand-built systemd units are the reference implementation.** Phase 1
is mechanising a procedure that is already proven in production here, including
the file-permission split discovered the hard way (§Phase 1.4).

---

## 3. Phase 0 — Preconditions

1. **Move `claude` and `codex` to dedicated sudo-less users.** They currently run
   as `kbs`, which holds `NOPASSWD: ALL`. A provider that accepts a private key
   and spawns remote shells must not land in an account one step from root.
2. **Rotate the workspace identity key** (exposed in a chat transcript). Note
   `agent_owner_pubkey` is immutable/first-write-wins per community, so existing
   agent→owner mappings cannot be re-pointed — new agent identities are required.
3. **Fork and branch** from the pinned commit. Keep the Phase 2 diff to ~3 files
   so rebases stay cheap.
4. **Re-verify the contract** — `agents_deploy.rs:112` and
   `agent_providers.rs:19` are the two that matter.

---

## 4. Phase 1 — `buzz-backend-ssh` (no upstream changes)

A single binary named `buzz-backend-ssh`, on the Mac's PATH or in `~/.local/bin`.

### 4.1 Transport

One JSON request on stdin (newline-terminated, then EOF), one JSON response on
stdout (`backend.rs:19-46`). Stdout is read incrementally, so responses need not
be newline-terminated. Timeouts: **10s** for `info`, **600s** for `deploy`
(`agent_providers.rs:40`, `backend.rs:372`).

### 4.2 `op:info`

```json
{"ok": true, "name": "ssh", "version": "0.1.0",
 "description": "Deploy Buzz agents to a remote host over SSH",
 "config_schema": {"type":"object","required":["host"],
   "properties":{
     "host":      {"type":"string","title":"SSH host (alias from ~/.ssh/config)"},
     "user":      {"type":"string","title":"Remote user"},
     "workdir":   {"type":"string","title":"Agent working directory"},
     "unit_prefix":{"type":"string","default":"buzz-acp-"}}}}
```

**Constraint:** `validate_provider_config` (`backend.rs:380`) rejects any config
key whose word-split contains `secret`, `password`, `token`, `key`, or
`credential`. Credentials must therefore come from `~/.ssh/config` and the SSH
agent — which suits the existing Cloudflare-Access-gated `gradient-ssh` alias.

### 4.3 `op:deploy`

Receives `{op, request_id, agent, provider_config}`; must return
`{"agent_id": "<stable id>"}` (`backend.rs:361`). Steps:

1. Derive `id` from `agent.name` (slugified) — must be stable across redeploys,
   because deploy is **idempotent by design**: re-deploying sends the same
   payload and the provider is expected to update in place. There is **no
   `undeploy` op** — the code comments mark it "deferred to v2"
   (`commands/agents.rs:455`).
2. `ssh <host>` and write `/etc/buzz-agents/<id>.env`, mode `0600`, root-owned —
   `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`, `BUZZ_RELAY_URL`, agent command/args,
   timeouts, parallelism, plus `env_vars`.
3. Write the system prompt to `/usr/local/share/buzz-agents/prompts/<id>.md`,
   mode `0644`.
4. Render and install `/etc/systemd/system/<unit_prefix><id>.service` with
   `User=`, `WorkingDirectory=`, `EnvironmentFile=`, and
   `ExecStart=/usr/local/bin/buzz-acp --respond-to <mode> [--respond-to-allowlist …]`.
5. `systemctl daemon-reload && systemctl enable --now <unit>`.
6. Return `{"agent_id": "<unit-name>"}`.

### 4.4 Non-obvious requirements (learned the hard way)

- **Never put the nsec in argv.** Pipe it over stdin to `tee`/`install` on the
  remote; argv is world-readable in `/proc`.
- **Secrets and prompts need different directories.** `/etc/buzz-agents` is
  `0700 root`, so an agent running as its own user cannot traverse it to read a
  prompt file — systemd reads `EnvironmentFile` as root, but the process reads
  the prompt as itself. Prompts must live outside, e.g.
  `/usr/local/share/buzz-agents/prompts` (`0755`, files `0644`).
- **Do not hardcode versioned paths** in `Environment=PATH` (a `hermes` venv dir
  named for an old version survived an upgrade and would have broken on the next).
- Surface remote `systemctl` failures as a non-zero exit with a message on
  stderr; Desktop stores it in `last_error` and shows it in the runtime details.

### 4.5 Dry-run

Support `BUZZ_BACKEND_SSH_DRY_RUN=1` to print the env file, unit file, and
remote command sequence to stderr and exit without touching the host. Makes the
first Desktop-driven deploy inspectable.

### 4.6 Acceptance

Create an agent in Desktop with **Run on = ssh**; a `buzz-acp-<id>.service`
appears on `gradient-ssh`, the agent shows `deployed` plus a green presence dot,
and it answers an `@mention` in a channel.

### 4.7 What Phase 1 does *not* fix

`agent_command` is chosen from the **local** catalog and shipped to the remote
host. You can deploy remotely, but you are still selecting from your Mac's
runtimes and hoping the same binary exists server-side. That is Phase 2.

---

## 5. Phase 2 — Runtime advertisement (upstream)

### 5.1 The gap

`BackendProviderProbeResult` is `{ok, name, version, description, config_schema}`
(`desktop/src/shared/api/types.ts:425`). **No runtime list.** Runtime discovery
probes the local PATH only (`managed_agents/discovery.rs`).

### 5.2 Minimal, backward-compatible change

1. Add optional `runtimes: [{id, label, command, default_args, version, available, auth_ok}]`
   to the `op:info` response. Absent ⇒ current behaviour.
2. Add `host` (or `provider_id`) to `AcpRuntimeCatalogEntry` (`types.rs:569`).
3. Make discovery return `union(local probe, provider-advertised)`.
4. Group the runtime dropdown by host; selecting a remote runtime auto-selects
   its provider under "Run on".

### 5.3 Design wrinkle

`KnownAcpRuntime` is `&'static` static data (`discovery/runtime_metadata.rs`).
Advertised runtimes are dynamic, so this needs something like:

```rust
enum RuntimeSource {
    Builtin(&'static KnownAcpRuntime),
    Advertised(ProviderRuntime),   // owned, from op:info
}
```

`desktop/src/features/agents/AGENTS.md` states the one rule: harness capability
facts have exactly one source, the Rust catalog, and the frontend must never keep
a rival table. So this **cannot** be shortcut in TypeScript.

### 5.4 Acceptance

`hermes 0.19.0` appears in the runtime dropdown on the Mac, labelled
`gradient-ssh`, with correct version and auth state — and a persona can pin it.

---

## 6. Phase 3 — Lifecycle gaps (small)

Most of this already exists (§2.2). What is genuinely missing:

- **Stop / undeploy.** No `op` exists; explicitly "deferred to v2". Add
  `op:stop` and `op:undeploy` (disable + remove unit, optionally purge env and
  prompt). Requires a matching upstream call site.
- **Log tail.** Optional `op:logs` returning the last N lines of
  `journalctl -u <unit>`, surfaced in the existing runtime-details panel.

Not needed: liveness (relay presence), status (control-plane axis), autostart
suppression, cleanup suppression — all already handled.

---

## 7. Phase 4 — Personas and teams (expected free)

Personas are kind:30175 (owner-authored) and teams kind:30176 with
`{name, description, instructions, persona_ids}` (`managed_agents/team_events.rs:68`),
both relay events, both already community-scoped, with proper NIP-09 coordinate
deletion. Once a remote runtime is selectable at persona-creation time, teams
should work unchanged.

**Acceptance:** a team of three remote agents added to a channel, coordinating.

---

## 8. Risks

| Risk | Severity | Note |
|---|---|---|
| Provider contract is undocumented and unannounced | High for Ph. 2–3 | No CHANGELOG, no preview flag, no `buzz-backend-*` implementation ships. Could change without notice. |
| Phase 2 carries a private fork of types the frontend projects | Medium | Diff most likely to rot. Worth proposing upstream despite the preference not to. |
| Private key crosses the SSH boundary | Medium | Inherent to the design; Desktop warns. Mitigate via Phase 0 item 1. |
| No `undeploy` | Low | Orphaned units accumulate until Phase 3. |
| Idempotency assumptions | Low | Stable `agent_id` derivation is mandatory, not optional. |

## 9. Effort

| Phase | Estimate | Upstream? |
|---|---|---|
| 0 — preconditions | ~1 h | No |
| 1 — `buzz-backend-ssh` | ~1 day | No |
| 2 — runtime advertisement | ~1–2 days + review | **Yes** |
| 3 — stop/undeploy/logs | ~1 day | Yes (call sites) |
| 4 — personas/teams | ~0 | No |

**Sequencing:** Phase 1 has standalone value and no upstream dependency. If
upstream reshapes the contract, that costs a day, not the project.
