/**
 * Owner-authored kind:30178 SWARM definitions — the relay counterpart of the
 * Swarms section on the Agents page. Mirrors `connectedAgentDefinition.ts`:
 * the relay is the source of truth (`publishSwarmDefinition` in tauri.ts
 * writes it owner-signed; the leader's harness reads it at session start),
 * and this module owns the fetch/query layer over the pure mapping in
 * `swarmDefinitionContent.ts`.
 */

import {
  mapSwarmEventsToDefinitions,
  parseSwarmContent,
  serializeSwarmContent,
  type SwarmDefinition,
  type SwarmMemberDefinition,
} from "@/features/agents/lib/swarmDefinitionContent";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_SWARM } from "@/shared/constants/kinds";
import { useQuery } from "@tanstack/react-query";

export type { SwarmDefinition, SwarmMemberDefinition };
export { parseSwarmContent, serializeSwarmContent };

/** Fetch the NIP-33 heads of every swarm the owner has defined. */
export async function fetchSwarmDefinitions(
  ownerPubkey: string,
): Promise<SwarmDefinition[]> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_SWARM],
    authors: [ownerPubkey.toLowerCase()],
    limit: 100,
  });
  return mapSwarmEventsToDefinitions(events);
}

export function swarmsQueryKey(ownerPubkey: string) {
  return ["swarm-definitions", ownerPubkey.toLowerCase()] as const;
}

/**
 * The current user's swarms. Enabled only when the owner pubkey is known —
 * swarms are owner-authored, so the section and mention aliasing only ever
 * surface the current identity's own definitions.
 */
export function useSwarmsQuery(ownerPubkey: string | undefined) {
  return useQuery<SwarmDefinition[]>({
    enabled: Boolean(ownerPubkey),
    queryKey: swarmsQueryKey(ownerPubkey ?? ""),
    queryFn: () => fetchSwarmDefinitions(ownerPubkey ?? ""),
    staleTime: 60_000,
  });
}
