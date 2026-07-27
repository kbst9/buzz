# buzz-backend-ssh

A Buzz agent **backend provider**: create and configure agents in Buzz Desktop,
run them on a remote host.

Desktop discovers executables named `buzz-backend-*` on `PATH`, in its own bundle
directory, and in `~/.local/bin`. Each becomes an entry in the agent dialog's
**"Run on"** selector. This provider turns a deploy payload into a `buzz-acp`
systemd unit on a host reached over SSH.

```
Buzz Desktop ──op:deploy (JSON/stdio)──▶ buzz-backend-ssh ──ssh──▶ systemd unit
                                                                   └─ buzz-acp ──▶ relay
```

## Install

```bash
cargo build --release -p buzz-backend-ssh
install -m 0755 target/release/buzz-backend-ssh ~/.local/bin/
```

Restart Buzz Desktop. "Run on" now offers **ssh** alongside "This computer".

## Requirements on the remote host

- `buzz-acp` at `/usr/local/bin/buzz-acp`
- The chosen runtime's binary on the target user's `PATH`
- Passwordless `sudo` for your SSH login user (it writes `/etc/systemd/system`)
- An SSH alias in `~/.ssh/config`. **Credentials are never accepted through
  provider config** — Desktop rejects any config key that looks like a secret,
  so authentication is your SSH agent's job.

## Configuration

Per-agent fields appear in the Desktop form:

| Field | Required | Meaning |
|---|---|---|
| `host` | yes | SSH alias |
| `user` | yes | Unix user the agent runs as |
| `runtime` | yes | Remote runtime: `claude`, `codex`, `goose`, `buzz-agent`, `hermes` |
| `workdir` | no | Defaults to `<workdir_base>/<id>` or `/home/<user>/buzz-agents/<id>` |

Optional defaults live in `~/.config/buzz-backend-ssh/config.toml` (auto-created,
commented):

```toml
default_host = "my-server"
default_user = "buzz"
workdir_base = "/home/buzz/agents"
unit_prefix  = "buzz-acp-"
probe_cache_seconds = 600
```

Setting `default_host` lets `op:info` probe that host and report which runtimes
are actually installed, pre-filling the form. Desktop renders provider config as
plain text inputs and ignores JSON Schema `enum`, so discovered runtimes appear in
the field *description* rather than as a dropdown.

> `workdir_base` is shared across agents while `user` is per-agent, so a base
> under one user's home will create directories there owned by another user. Leave
> it unset unless every agent shares a user.

## Why `runtime` exists

Desktop resolves `agent_command` from the runtime catalog of the machine running
**Desktop**, then ships it in the payload. On a laptop that is often only the
bundled `buzz-agent`, while the server has the adapters worth running. So
`runtime` names the *remote* runtime and the provider substitutes the command
before writing the unit.

`hermes` is available here even though it is absent from Desktop's catalog —
possible precisely because the provider, not Desktop, decides the remote command.

## What a deploy writes

| Path | Mode | Contents |
|---|---|---|
| `/etc/buzz-agents/<id>.env` | `0600 root` | nsec, NIP-OA attestation, harness config |
| `/usr/local/share/buzz-agents/prompts/<id>.md` | `0644 root` | system prompt |
| `/etc/systemd/system/buzz-acp-<id>.service` | `0644 root` | the unit |

Prompts deliberately live **outside** `/etc/buzz-agents`: that directory is
`0700 root` because it holds keys, and the harness reads its prompt as the
agent's own user. A prompt stored beside the secrets fails at runtime with
`configuration error: failed to read file: Permission denied`.

## Safety properties

- **Secrets never reach argv.** The install script is piped to `ssh` on stdin and
  secrets sit inside quoted heredocs, so nothing sensitive appears in
  `/proc/*/cmdline` on either host, or in shell history.
- **Preflight before install.** The target user must exist, `buzz-acp` must be
  present, and the runtime must resolve on that user's `PATH` — otherwise the
  deploy fails with a precise message instead of leaving a crash-looping unit.
- **Atomic writes.** Files are staged to `mktemp` and moved with `install`, so an
  interrupted deploy cannot leave an agent with a half-written identity.
- **Start is verified.** After `enable --now` the script polls `is-active` and, on
  failure, returns the last 25 journal lines. Desktop shows that as `last_error`.

## Dry run

```bash
BUZZ_BACKEND_SSH_DRY_RUN=1 buzz-backend-ssh < request.json
```

Prints the env file, unit, prompt, and install script to stderr and touches
nothing. Useful for inspecting a first deploy before it lands.

## Protocol

```jsonc
// → {"op":"info"}
{"ok":true,"name":"ssh","version":"0.1.0","description":"…","config_schema":{…}}

// → {"op":"deploy","agent":{…},"provider_config":{…}}
{"agent_id":"buzz-acp-<id>.service"}
```

Errors exit non-zero with a message on **stderr** — Desktop captures that into
`last_error`. An error object on stdout would instead surface as the generic
"deploy response missing agent_id".

## Known limitations

- **No undeploy.** The protocol has no such op ("deferred to v2" in Desktop), so
  removing an agent in Desktop leaves the remote unit running. Remove by hand:
  `systemctl disable --now buzz-acp-<id>` and delete the three files.
- **Renaming orphans a unit.** The id is a slug of the agent name, so a rename
  deploys a new unit and abandons the old one.
- **Runtime selection is per-agent, not catalog-integrated.** The Desktop runtime
  dropdown still lists *local* runtimes; the remote choice is made in this
  provider's config. Fixing that properly needs an upstream change — an optional
  `runtimes: […]` array on the `op:info` response plus a host field on
  `AcpRuntimeCatalogEntry`.
- **Model/provider env vars** are only mapped for runtimes where Desktop's own
  catalog defines them (`goose`, `buzz-agent`). For others, set them through the
  persona's env vars.
