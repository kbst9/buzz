/**
 * Pure provisioning-plan rendering for fleet.toml entries.
 *
 * Everything here is deterministic text generation — the executor
 * (scripts/provision-fleet.ts) supplies the generated keypair and performs
 * the privileged writes. Keeping renderers pure lets the golden tests pin
 * the exact env-file and unit-file bytes an entry produces.
 */

import type { FleetAgent, FleetSettings } from "./config.js";

/** File paths a provisioned agent occupies on the host. */
export function agentPaths(name: string): {
  envFile: string;
  unitFile: string;
  unitName: string;
  dropInDir: string;
  dropInFile: string;
} {
  const unitName = `buzz-acp-${name}`;
  return {
    envFile: `/etc/buzz-agents/${name}.env`,
    unitFile: `/etc/systemd/system/${unitName}.service`,
    unitName,
    dropInDir: `/etc/systemd/system/${unitName}.service.d`,
    dropInFile: `/etc/systemd/system/${unitName}.service.d/provider.conf`,
  };
}

/**
 * Render the per-agent env file. Mirrors new-standalone-agent.sh invite mode
 * plus the flue-tier vars (BUZZ_ACP_AGENT_COMMAND to flue-acp, BUZZ_FLUE_MODEL).
 * `privateKeyHex` is the host-generated agent secret — the only secret in the
 * file, same posture as the interactive script.
 */
export function renderEnvFile(
  fleet: FleetSettings,
  agent: FleetAgent,
  privateKeyHex: string,
): string {
  const lines = [
    `BUZZ_RELAY_URL=${fleet.relayUrl}`,
    `BUZZ_PRIVATE_KEY=${privateKeyHex}`,
    `BUZZ_INVITE_CODE=${fleet.inviteCode}`,
    `BUZZ_ACP_AGENT_OWNER=${fleet.ownerPubkey}`,
    `BUZZ_ACP_RESPOND_TO=${agent.respondTo}`,
  ];
  if (agent.allowlist.length > 0) {
    lines.push(`BUZZ_ACP_RESPOND_TO_ALLOWLIST=${agent.allowlist.join(",")}`);
  }
  lines.push(
    `BUZZ_ACP_AGENT_COMMAND=${fleet.agentCommand}`,
    `BUZZ_FLUE_MODEL=${agent.model}`,
    "BUZZ_ACP_RELAY_OBSERVER=true",
    `BUZZ_ACP_PROFILE_NAME=${agent.displayName}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Render the systemd unit. Identical shape to new-standalone-agent.sh so
 * fleet units and hand-provisioned units stay operationally interchangeable.
 * `acpBinary` is the resolved buzz-acp path (the executor looks it up once).
 */
export function renderUnitFile(
  fleet: FleetSettings,
  agent: FleetAgent,
  acpBinary: string,
): string {
  const { envFile } = agentPaths(agent.name);
  return `[Unit]
Description=Buzz ACP agent (${agent.name})
After=network-online.target
Wants=network-online.target

[Service]
User=${fleet.runUser}
# buzz-acp resolves, seeds, and enters its workspace (~/.buzz) itself;
# starting in the home directory is belt-and-braces for older binaries
# and any non-buzz tools the agent shells out to.
WorkingDirectory=~
EnvironmentFile=${envFile}
ExecStart=${acpBinary} --agents 2
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Render the optional provider drop-in — the shared credential file joins
 * each unit's environment without ever entering the per-agent env file,
 * mirroring the buzz-acp-flue provider.conf pattern.
 */
export function renderProviderDropIn(providerEnv: string): string {
  return `[Service]
EnvironmentFile=${providerEnv}
`;
}
