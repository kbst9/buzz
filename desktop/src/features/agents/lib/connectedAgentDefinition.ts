/**
 * Owner-authored kind:30177 definition for a CONNECTED agent — the relay
 * counterpart of the Instructions editor in Settings › Connected agents.
 *
 * The desktop holds no record for connected agents, so the definition on the
 * relay is the source of truth: `setConnectedAgentInstructions` (tauri.ts)
 * writes it through the retention flush pipe, and the agent's harness reads
 * `system_prompt` into its `[System]` section at each new session.
 */

import {
  parseConnectedAgentDefinition,
  type ConnectedAgentDefinition,
} from "@/features/agents/lib/connectedAgentDefinitionContent";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds";
import { useQuery } from "@tanstack/react-query";

export type { ConnectedAgentDefinition };
export { parseConnectedAgentDefinition };

/** Fetch the owner-authored definition head for one agent, if any. */
export async function fetchConnectedAgentDefinition(
  ownerPubkey: string,
  agentPubkey: string,
): Promise<ConnectedAgentDefinition> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_MANAGED_AGENT],
    authors: [ownerPubkey.toLowerCase()],
    "#d": [agentPubkey.toLowerCase()],
    limit: 1,
  });
  return parseConnectedAgentDefinition(
    events[events.length - 1]?.content ?? null,
  );
}

export function connectedAgentDefinitionQueryKey(
  ownerPubkey: string,
  agentPubkey: string,
) {
  return [
    "connected-agent-definition",
    ownerPubkey.toLowerCase(),
    agentPubkey.toLowerCase(),
  ] as const;
}

/**
 * The current definition backing the Instructions field of the edit dialog.
 * Enabled only when both pubkeys are known (the dialog only edits agents the
 * current user owns).
 */
export function useConnectedAgentDefinitionQuery(
  ownerPubkey: string | undefined,
  agentPubkey: string | undefined,
) {
  return useQuery<ConnectedAgentDefinition>({
    enabled: Boolean(ownerPubkey && agentPubkey),
    queryKey: connectedAgentDefinitionQueryKey(
      ownerPubkey ?? "",
      agentPubkey ?? "",
    ),
    queryFn: () =>
      fetchConnectedAgentDefinition(ownerPubkey ?? "", agentPubkey ?? ""),
    staleTime: 60_000,
  });
}
