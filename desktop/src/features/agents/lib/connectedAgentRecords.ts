import type { ManagedAgent, UserSearchResult } from "@/shared/api/types";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

/**
 * Display label for a connected agent: profile display name, then NIP-05
 * handle, then the canonical truncated pubkey. Mirrors the label used by
 * Settings › Connected agents.
 */
export function connectedAgentLabel(agent: UserSearchResult): string {
  return (
    agent.displayName?.trim() ||
    agent.nip05Handle?.trim() ||
    truncatePubkey(agent.pubkey)
  );
}

/**
 * Enumerate connected agents from the community directory: keep only
 * verified agent identities (`isAgent`), drop pubkeys already covered by
 * the managed-agents list and duplicate directory entries, then sort
 * owned-by-viewer first and by label within each group. Mirrors the
 * Settings › Connected agents enumeration.
 */
export function selectConnectedAgents(
  directoryUsers: UserSearchResult[],
  managedPubkeys: ReadonlySet<string>,
  viewerPubkey: string | null,
): UserSearchResult[] {
  const seen = new Set<string>();
  const agents: UserSearchResult[] = [];
  for (const user of directoryUsers) {
    const pubkey = normalizePubkey(user.pubkey);
    if (!user.isAgent || managedPubkeys.has(pubkey) || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    agents.push(user);
  }
  const mine = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  return agents.sort((left, right) => {
    const leftMine = Boolean(
      mine && left.ownerPubkey && normalizePubkey(left.ownerPubkey) === mine,
    );
    const rightMine = Boolean(
      mine && right.ownerPubkey && normalizePubkey(right.ownerPubkey) === mine,
    );
    if (leftMine !== rightMine) {
      return leftMine ? -1 : 1;
    }
    return connectedAgentLabel(left).localeCompare(connectedAgentLabel(right));
  });
}

/**
 * Synthesize a `ManagedAgent`-shaped record for a connected (standalone)
 * agent so it renders through the exact same identity-card component as
 * managed agents — the design requirement is identical look, not a
 * separate card design. Managed-only chrome self-gates on
 * `backend.type === "local"`, so the synthetic `provider/connected`
 * backend keeps it off wherever the record travels. Follows the
 * `profileActivityAgent` synthesis precedent.
 */
export function synthesizeConnectedAgentRecord(
  agent: UserSearchResult,
): ManagedAgent {
  return {
    pubkey: agent.pubkey,
    name: connectedAgentLabel(agent),
    personaId: null,
    runtime: null,
    teamId: null,
    relayUrl: "",
    acpCommand: "",
    // The harness command of a standalone agent is unknown to this app.
    agentCommand: "—",
    agentCommandOverride: null,
    agentArgs: [],
    mcpCommand: "",
    turnTimeoutSeconds: 0,
    idleTimeoutSeconds: null,
    maxTurnDurationSeconds: null,
    parallelism: 1,
    systemPrompt: null,
    avatarUrl: agent.avatarUrl ?? null,
    model: null,
    modelSource: null,
    provider: null,
    personaOutOfDate: false,
    personaOrphaned: false,
    needsRestart: false,
    restartDiff: [],
    envVars: {},
    status: "deployed",
    pid: null,
    createdAt: "",
    updatedAt: "",
    lastStartedAt: null,
    lastStoppedAt: null,
    lastExitCode: null,
    lastError: null,
    lastErrorCode: null,
    logPath: "",
    startOnAppLaunch: false,
    autoRestartOnConfigChange: false,
    backend: { type: "provider", id: "connected", config: {} },
    backendAgentId: null,
    respondTo: "anyone",
    respondToAllowlist: [],
  };
}
