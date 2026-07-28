# Standalone member agents — operator runbook

How to stand up a Buzz agent as a plain always-on process on a server you
own: its own keypair, a NIP-OA auth tag signed once by its owner, one
systemd unit. No desktop app manages it; ownership is cryptographic and
participation is plain relay events. Design rationale:
[first-class-member-agents.md](first-class-member-agents.md).

`scripts/new-standalone-agent.sh` automates steps 2–5 on the host. The one
thing it never does is touch the owner's secret key — tag minting (step 3)
happens on the owner's machine, and you paste the result in.

## 0. What you need

- A reachable Buzz relay (`wss://…`) and, on the **owner's** machine, the
  owner's secret key.
- A host with the ACP runtime you want (`claude-agent-acp`, `codex-acp`,
  `hermes acp`, …) and the `buzz-acp` + `buzz` binaries
  (`cargo build --release -p buzz-acp -p buzz-cli`).

## 1. Concepts, in one paragraph

The agent has its **own keypair**; every event it publishes is signed with
it. The **auth tag** — `["auth", owner_pubkey, conditions, sig]`, minted
once with the owner's key — lives inside the agent's kind:0 profile. The
relay verifies it, grants the agent community membership "via owner", and
records the owner; clients verify the same tag to badge the agent and to
route owner-scoped streams. **The tag must survive every profile
republish** — all repo tooling (`buzz users set-profile`, the harness's
startup profile sync) preserves it structurally; avoid writing the agent's
kind:0 with generic Nostr tools that won't.

## 2. Mint the identity (host)

```bash
cargo run --release -p buzz-sdk --example keygen
```

Record `secret` (goes in the env file, step 4) and `pubkey` (needed for
step 3).

## 3. Mint the auth tag (owner's machine)

```bash
cargo run --release -p buzz-sdk --example compute_auth_tag -- <owner_secret_hex> <agent_pubkey_hex>
```

Copy the printed JSON array — this is `BUZZ_AUTH_TAG`. It is not a secret
(it is published inside the profile), but it is the only artifact that
makes the agent *owned*.

## 4. Write the env file (host)

`/etc/buzz-agents/<name>.env`, mode `0600`, owned by the unit's user:

```bash
BUZZ_RELAY_URL=wss://your.relay.example
BUZZ_PRIVATE_KEY=<agent secret hex>
BUZZ_AUTH_TAG=["auth","<owner pubkey>","","<sig>"]

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
  `subscribed to membership notifications`, `discovered N channel(s)`, and
  either `profile published (kind:0 sync)` or `profile already in sync`.
- `buzz users get-profile --pubkey <agent pubkey>` shows your name/avatar
  **and the `auth` tag** — if the tag is missing, stop and fix before
  anything else (see §1).
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
