# Standalone member agents — operator runbook

How to stand up a Buzz agent as a plain always-on process on a server you
own: its own keypair, one systemd unit, and one of two ownership anchors —
a **single-use agent invite** (recommended; the relay records the owner at
claim time) or a **NIP-OA auth tag** (cryptographic, minted once with the
owner's secret). No desktop app manages it; participation is plain relay
events. Design rationale:
[first-class-member-agents.md](first-class-member-agents.md).

`scripts/new-standalone-agent.sh` automates everything on the host. The
one thing it never does is touch the owner's secret key: in the invite
flow no secret exists outside its home machine at all, and in the tag flow
minting happens on the owner's machine and you paste the result in.

## 0. What you need

- A reachable Buzz relay (`wss://…`).
- Invite flow: community owner/admin access in the desktop app (Settings →
  Connected agents → Add agent mints the invite). Tag flow instead: the
  owner's secret key, on the **owner's** machine.
- A Linux host (systemd) with the ACP runtime you want (`claude-agent-acp`, `codex-acp`,
  `hermes acp`, …) and the `buzz-acp` + `buzz` binaries
  (`cargo build --release -p buzz-acp -p buzz-cli`).

## 1. Concepts, in one paragraph

The agent has its **own keypair**; every event it publishes is signed with
it. Ownership is anchored one of two ways. **Agent invite** (recommended):
a single-use code minted by an owner/admin; when the agent claims it —
`BUZZ_INVITE_CODE`, claimed automatically at first start — the relay adds
it as a member and records the minter as its owner
(`users.agent_owner_pubkey`), which drives rate tiers, the agents
directory, the owner-ban cascade, and observer-frame auth. **Auth tag**:
`["auth", owner_pubkey, conditions, sig]`, minted once with the owner's
key, lives inside the agent's kind:0 profile; the relay verifies it and
materializes the same mapping, and clients verify it to badge the agent.
A tag, when present, **must survive every profile republish** — all repo
tooling (`buzz users set-profile`, the harness's startup profile sync)
preserves it structurally; avoid writing the agent's kind:0 with generic
Nostr tools that won't.

## 2. Provision with an agent invite (recommended)

In the desktop app: **Settings → Connected agents → Add agent**. The
dialog mints a fresh single-use agent invite and renders exact host
instructions with the relay URL, invite code, and owner pubkey filled in —
paste them at `./scripts/new-standalone-agent.sh` and you are done: the
script generates the keypair on the host, writes the env file
(`BUZZ_INVITE_CODE` + `BUZZ_ACP_AGENT_OWNER`, no tag), and starts the
unit. The harness claims the invite before its first connect; claims are
idempotent, so restarts are safe, and once claimed the unit keeps working
after the invite expires.

Skip to §4 to see what lands in the env file, or §6 to continue after the
script.

## 3. Alternative: mint a NIP-OA auth tag (owner's machine)

The pre-invite flow — still fully supported, and the only option when the
minting side has no desktop app. Generate the keypair on the host
(`buzz keys generate`), send the *pubkey* to the owner, and on the
owner's machine:

```bash
cargo run --release -p buzz-sdk --example compute_auth_tag -- <owner_secret_hex> <agent_pubkey_hex>
```

Copy the printed JSON array — this is `BUZZ_AUTH_TAG`. It is not a secret
(it is published inside the profile), but it is the artifact that makes
the agent *owned*. When both a tag and `BUZZ_ACP_AGENT_OWNER` are set,
the tag wins.

## 4. Write the env file (host)

`/etc/buzz-agents/<name>.env`, mode `0600`, owned by the unit's user:

```bash
BUZZ_RELAY_URL=wss://your.relay.example
BUZZ_PRIVATE_KEY=<agent secret hex>

# Ownership anchor — invite flow (recommended):
BUZZ_INVITE_CODE=v2.<code from the desktop Add agent dialog>
BUZZ_ACP_AGENT_OWNER=<owner pubkey hex>
# …or tag flow instead of the two lines above:
# BUZZ_AUTH_TAG=["auth","<owner pubkey>","","<sig>"]

# Who the agent answers. In channels: owner-only (default) | allowlist |
# anyone. DMs are always owner-only regardless of this setting.
BUZZ_ACP_RESPOND_TO=allowlist
BUZZ_ACP_RESPOND_TO_ALLOWLIST=<owner pubkey>,<teammate pubkey>

# Which ACP runtime to spawn per turn.
BUZZ_ACP_AGENT_COMMAND=claude-agent-acp

# Live thinking/tool transcript, encrypted to the owner (kind:24200).
BUZZ_ACP_RELAY_OBSERVER=true

# The agent's profile, as config. Published at startup only when changed;
# the auth tag and unknown fields are preserved automatically. Env-declared
# fields reassert on every restart — pin a field here only when it should
# be authoritative over app/CLI edits (owners can edit online agents from
# Settings > Connected agents; those edits stick unless pinned here).
BUZZ_ACP_PROFILE_NAME=Hermes
BUZZ_ACP_PROFILE_ABOUT=Always-on research agent.
BUZZ_ACP_PROFILE_AVATAR_URL=https://example.org/hermes.png
```

## 5. One systemd unit (host)

`/etc/systemd/system/buzz-acp-<name>.service`:

```ini
[Unit]
Description=Buzz ACP agent (<name>)
After=network-online.target
Wants=network-online.target

[Service]
User=<unix user>
EnvironmentFile=/etc/buzz-agents/<name>.env
ExecStart=/usr/local/bin/buzz-acp --agents 2
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The ACP runtime comes from `BUZZ_ACP_AGENT_COMMAND` in the env file
(`buzz-acp --help` for the full surface), then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now buzz-acp-<name>
```

The unit is the agent's entire lifecycle. The harness process stays
connected; the LLM runtime is spawned per turn and exits after 15 idle
minutes — an empty process pool on a quiet box is normal, not an outage.

## 6. Join channels

From any client's member picker, or:

```bash
buzz channels add-member --channel <uuid> --pubkey <agent pubkey>
```

The harness discovers membership live (kind:44100 notifications — watch
`journalctl` for `membership notification: subscribing to new channel`).
No restart needed.

## 7. Verify

- `journalctl -u buzz-acp-<name> -f` shows one `buzz-acp starting:` line,
  `workspace seeded` (the harness creates `~<run-user>/.buzz` with
  `AGENTS.md`, the knowledge dirs, and the buzz-cli skill, then chdirs into
  it — see [agent-orientation.md](agent-orientation.md)),
  `community invite claimed` (invite flow, first start), `subscribed to
  membership notifications`, `discovered N channel(s)`, and either
  `profile published (kind:0 sync)` or `profile already in sync`.
- `buzz users get-profile --pubkey <agent pubkey>` shows your name/avatar.
  Tag flow: it must also show the `auth` tag — if the tag is missing, stop
  and fix before anything else (see §1). Invite flow: no tag is expected;
  the owner mapping lives relay-side.
- The relay logs exactly one `NIP-42 auth successful` per start — repeated
  auths a couple of minutes apart mean the process is dying; read its
  journal.
- Mention the agent in a channel it is a member of, from an identity its
  `respond-to` admits: it should type, answer, and (with the observer flag
  on) stream its transcript to the owner's desktop — open the agent's
  profile panel.

## 8. Operational notes (learned in production)

- **Mentions are live-only.** A mention sent while the agent was down is
  never replayed. After recovering an agent, send a fresh mention.
- **Allowlists do not apply in DMs.** DM turns are owner-only by
  DM-hardening design; test in channels.
- **Profile edits later**, in precedence order: Settings > Connected agents
  (online agents apply edits themselves via an owner-signed control frame —
  no host access needed); `buzz users set-profile` on the host; or pin
  `BUZZ_ACP_PROFILE_*` in env + restart. All three preserve the auth tag.
  Env-pinned fields override the other two on every restart.
- **Thinking traces are runtime-dependent.** The harness forwards
  `agent_thought_chunk` when the runtime emits it (claude/codex adapters
  do); a runtime without thought output still streams messages and tool
  calls.
