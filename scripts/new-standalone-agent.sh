#!/usr/bin/env bash
# Stand up a new standalone Buzz agent on this host.
# See docs/standalone-agents.md. This script NEVER handles the owner's
# secret key. Two provisioning modes:
#   - invite (recommended): paste the single-use agent invite code from the
#     desktop's "Add agent" dialog — the agent claims it on first start and
#     is attributed to the owner relay-side. No tag round-trip.
#   - auth tag (manual): mint the NIP-OA tag on the owner's machine and
#     paste it here.
set -euo pipefail

say() { printf '\n%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -d crates/buzz-sdk ]] || die "run from a buzz repo checkout"
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
if KEYGEN_OUT="$(buzz keys generate 2>/dev/null)"; then
  SECRET="$(sed -n 's/.*"private_key":"\([0-9a-f]\{64\}\)".*/\1/p' <<<"$KEYGEN_OUT")"
  PUBKEY="$(sed -n 's/.*"public_key":"\([0-9a-f]\{64\}\)".*/\1/p' <<<"$KEYGEN_OUT")"
else
  # Older buzz CLI without `keys generate` — fall back to the cargo example.
  KEYGEN_OUT="$(cargo run --release -q -p buzz-sdk --example keygen)"
  SECRET="$(sed -n 's/^secret=//p' <<<"$KEYGEN_OUT")"
  PUBKEY="$(sed -n 's/^pubkey=//p' <<<"$KEYGEN_OUT")"
fi
[[ -n "$SECRET" && -n "$PUBKEY" ]] || die "keygen failed"
say "Agent pubkey: $PUBKEY"

say "Membership: paste the single-use agent invite code from the desktop's
Settings → Connected agents → Add agent dialog (recommended), or press
enter to use the manual NIP-OA auth-tag flow."
read -rp "Invite code (v2.…, empty for auth-tag flow): " INVITE_CODE

AUTH_TAG=""
OWNER_PUBKEY=""
if [[ -n "$INVITE_CODE" ]]; then
  [[ "$INVITE_CODE" == v2.* ]] || die "invite codes start with v2."
  read -rp "Owner pubkey (64-char hex, shown in the same dialog): " OWNER_PUBKEY
  [[ "$OWNER_PUBKEY" =~ ^[0-9a-f]{64}$ ]] || die "owner pubkey must be 64-char lowercase hex"
else
  say "On the OWNER's machine, mint the auth tag now:
  cargo run --release -p buzz-sdk --example compute_auth_tag -- <owner_secret_hex> $PUBKEY"
  read -rp "Paste the auth tag JSON: " AUTH_TAG
  [[ "$AUTH_TAG" == '["auth"'* ]] || die "that does not look like an auth tag"
fi

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
$( [[ -n "$INVITE_CODE" ]] && echo "BUZZ_INVITE_CODE=${INVITE_CODE}" )
$( [[ -n "$OWNER_PUBKEY" ]] && echo "BUZZ_ACP_AGENT_OWNER=${OWNER_PUBKEY}" )
$( [[ -n "$AUTH_TAG" ]] && echo "BUZZ_AUTH_TAG=${AUTH_TAG}" )
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
# buzz-acp resolves, seeds, and enters its workspace (~/.buzz) itself;
# starting in the home directory is belt-and-braces for older binaries
# and any non-buzz tools the agent shells out to.
WorkingDirectory=~
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

VERIFY_EXPECT='profile published (kind:0 sync) + discovered N channel(s)'
if [[ -n "$INVITE_CODE" ]]; then
  VERIFY_EXPECT="community invite claimed + ${VERIFY_EXPECT}"
fi
say "Done. Verify with:
  journalctl -u buzz-acp-${NAME} -f
  # expect: ${VERIFY_EXPECT}
Then add the agent to a channel (member picker, or):
  buzz channels add-member --channel <uuid> --pubkey ${PUBKEY}
And send it a fresh mention — mentions from before a start are never replayed."
