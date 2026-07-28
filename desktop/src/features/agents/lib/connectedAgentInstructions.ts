/**
 * Copy-pastable instruction blocks for standalone ("connected") agents.
 *
 * The desktop deliberately holds no standalone agent's key, so it cannot
 * provision or edit one directly — instead it generates exact, filled-in
 * instructions for whoever operates the host (a human, or an AI agent with
 * shell access there). See docs/standalone-agents.md for the underlying
 * runbook these templates condense.
 */

/** Kebab-case a display name into a plausible systemd unit suffix. */
export function unitSlugForAgentName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

export function buildAddAgentInstructions(input: {
  relayUrl: string;
  ownerPubkey: string;
}): string {
  const { relayUrl, ownerPubkey } = input;
  return `You are operating a Linux/macOS host that will run a new standalone Buzz agent.
Follow these steps exactly. Full reference: docs/standalone-agents.md in block/buzz.

1. Build the binaries (once per host), from a checkout of the buzz repo:
   cargo build --release -p buzz-acp -p buzz-cli
   sudo install -m755 target/release/buzz-acp target/release/buzz /usr/local/bin/

2. Generate the agent's keypair ON THIS HOST (the secret never leaves it):
   cargo run --release -p buzz-sdk --example keygen
   Record both lines (secret=…, pubkey=…).

3. STOP and ask the owner to mint the auth tag. Send them the agent pubkey
   and this command — it needs their secret key, which you must never ask for:
   cargo run --release -p buzz-sdk --example compute_auth_tag -- <owner_secret_hex> <agent_pubkey>
   The owner's pubkey is ${ownerPubkey} — verify the tag they return embeds it.

4. Run the provisioning script and answer its prompts (it writes the env
   file and systemd unit, then enables the service):
   ./scripts/new-standalone-agent.sh
   Use relay URL: ${relayUrl}
   When it asks for the auth tag, paste the JSON from step 3.

   (No script? Create /etc/buzz-agents/<name>.env and a buzz-acp-<name>.service
   per docs/standalone-agents.md §4–5 — same content, by hand.)

5. Verify:
   journalctl -u buzz-acp-<name> -f
   Expect: "profile published (kind:0 sync)", "subscribed to membership notifications".
   Then report the agent pubkey back to the owner so they can add it to
   channels from the app's member picker. Mentions sent before the agent
   was running are never replayed — test with a fresh mention.`;
}

export function buildEditAgentInstructions(input: {
  agentName: string;
  name?: string;
  about?: string;
  avatarUrl?: string;
}): string {
  const unit = unitSlugForAgentName(input.agentName);
  const envLines = [
    input.name !== undefined && `BUZZ_ACP_PROFILE_NAME=${input.name}`,
    input.about !== undefined && `BUZZ_ACP_PROFILE_ABOUT=${input.about}`,
    input.avatarUrl !== undefined &&
      `BUZZ_ACP_PROFILE_AVATAR_URL=${input.avatarUrl}`,
  ].filter((line): line is string => Boolean(line));

  const cliFlags = [
    input.name !== undefined && `--name ${shellQuote(input.name)}`,
    input.about !== undefined && `--about ${shellQuote(input.about)}`,
    input.avatarUrl !== undefined && `--avatar ${shellQuote(input.avatarUrl)}`,
  ]
    .filter((flag): flag is string => Boolean(flag))
    .join(" ");

  return `On the host that runs "${input.agentName}" (unit name may differ — check systemctl list-units "buzz-acp-*"):

Declarative (survives restarts) — set these in /etc/buzz-agents/${unit}.env:
${envLines.map((line) => `   ${line}`).join("\n")}
then:
   sudo systemctl restart buzz-acp-${unit}
   journalctl -u buzz-acp-${unit} -n 20 | grep -i profile
   # expect: profile published (kind:0 sync)

One-off alternative (no restart; env-declared fields win on next restart):
   sudo bash -c 'set -a; source /etc/buzz-agents/${unit}.env; set +a; buzz users set-profile ${cliFlags}'

Both paths preserve the agent's NIP-OA auth tag automatically.`;
}

/** Minimal single-quote shell escaping for generated command lines. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
