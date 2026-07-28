#!/usr/bin/env bash
# Stand up a new standalone Buzz agent on this host (runbook steps 2-5).
# See docs/standalone-agents.md. This script NEVER handles the owner's
# secret key: mint the auth tag on the owner's machine and paste it here.
set -euo pipefail

say() { printf '\n%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -f crates/buzz-sdk/examples/keygen.rs ]] || die "run from a buzz repo checkout (needs cargo examples)"
command -v systemctl >/dev/null || die "systemd required (Linux host)"
command -v buzz-acp >/dev/null || die "buzz-acp not on PATH (cargo build --release -p buzz-acp)"
command -v buzz >/dev/null || die "buzz CLI not on PATH (cargo build --release -p buzz-cli)"

read -rp "Agent name (unit suffix, e.g. hermes): " NAME
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || die "name must be lowercase alphanumeric/dash"
read -rp "Relay URL (wss://…): " RELAY_URL
[[ "$RELAY_URL" == wss://* || "$RELAY_URL" == ws://* ]] || die "relay URL must be ws(s)://"
read -rp "ACP runtime command (e.g. claude-agent-acp): " AGENT_CMD
read -rp "Unix user to run as [$USER]: " RUN_USER
RUN_USER="${RUN_USER:-$USER}"
read -rp "Display name [${NAME}]: " PROFILE_NAME
PROFILE_NAME="${PROFILE_NAME:-$NAME}"
read -rp "Avatar URL (http(s), empty to skip): " AVATAR_URL
read -rp "respond-to (owner-only/allowlist/anyone) [allowlist]: " RESPOND_TO
RESPOND_TO="${RESPOND_TO:-allowlist}"
[[ "$RESPOND_TO" =~ ^(owner-only|allowlist|anyone|nobody)$ ]] || die "respond-to must be owner-only, allowlist, anyone, or nobody"
ALLOWLIST=""
if [[ "$RESPOND_TO" == "allowlist" ]]; then
  read -rp "Allowlist pubkeys (comma-separated hex): " ALLOWLIST
fi

say "Generating the agent keypair (secret stays on this host)…"
KEYGEN_OUT="$(cargo run --release -q -p buzz-sdk --example keygen)"
SECRET="$(sed -n 's/^secret=//p' <<<"$KEYGEN_OUT")"
PUBKEY="$(sed -n 's/^pubkey=//p' <<<"$KEYGEN_OUT")"
[[ -n "$SECRET" && -n "$PUBKEY" ]] || die "keygen failed"

say "Agent pubkey: $PUBKEY"
say "On the OWNER's machine, mint the auth tag now:
  cargo run --release -p buzz-sdk --example compute_auth_tag -- <owner_secret_hex> $PUBKEY"
read -rp "Paste the auth tag JSON: " AUTH_TAG
[[ "$AUTH_TAG" == '["auth"'* ]] || die "that does not look like an auth tag"

ENV_FILE="/etc/buzz-agents/${NAME}.env"
UNIT_FILE="/etc/systemd/system/buzz-acp-${NAME}.service"
[[ -e "$ENV_FILE" ]] && die "$ENV_FILE already exists"
[[ -e "$UNIT_FILE" ]] && die "$UNIT_FILE already exists"

say "Writing $ENV_FILE (sudo)…"
sudo install -d -m 0755 /etc/buzz-agents
sudo install -m 0600 -o "$RUN_USER" /dev/null "$ENV_FILE"
sudo tee "$ENV_FILE" >/dev/null <<ENV
BUZZ_RELAY_URL=${RELAY_URL}
BUZZ_PRIVATE_KEY=${SECRET}
BUZZ_AUTH_TAG=${AUTH_TAG}
BUZZ_ACP_RESPOND_TO=${RESPOND_TO}
$( [[ -n "$ALLOWLIST" ]] && echo "BUZZ_ACP_RESPOND_TO_ALLOWLIST=${ALLOWLIST}" )
BUZZ_ACP_AGENT_COMMAND=${AGENT_CMD}
BUZZ_ACP_RELAY_OBSERVER=true
BUZZ_ACP_PROFILE_NAME=${PROFILE_NAME}
$( [[ -n "$AVATAR_URL" ]] && echo "BUZZ_ACP_PROFILE_AVATAR_URL=${AVATAR_URL}" )
ENV

say "Writing $UNIT_FILE (sudo)…"
sudo tee "$UNIT_FILE" >/dev/null <<UNIT
[Unit]
Description=Buzz ACP agent (${NAME})
After=network-online.target
Wants=network-online.target

[Service]
User=${RUN_USER}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v buzz-acp) --agents 2
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

say "Enabling and starting…"
sudo systemctl daemon-reload
sudo systemctl enable --now "buzz-acp-${NAME}"

say "Done. Verify with:
  journalctl -u buzz-acp-${NAME} -f
  # expect: profile published (kind:0 sync) + discovered N channel(s)
Then add the agent to a channel (member picker, or):
  buzz channels add-member --channel <uuid> --pubkey ${PUBKEY}
And send it a fresh mention — mentions from before a start are never replayed."
