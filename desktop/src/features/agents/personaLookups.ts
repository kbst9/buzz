import type {
  AgentPersona,
  ManagedAgent,
  RespondToMode,
} from "@/shared/api/types";

/**
 * Per-pubkey lookups derived from the managed-agent and persona lists:
 * the persona display name an agent presents as, and the agent's
 * respond-to gating mode. Keys are lowercased agent pubkeys.
 */
export function buildAgentPersonaLookups(
  agents: ManagedAgent[],
  personas: AgentPersona[],
): {
  personaLookup: Map<string, string>;
  respondToLookup: Map<string, RespondToMode>;
} {
  const personaById = new Map(personas.map((p) => [p.id, p.displayName]));
  const personaLookup = new Map<string, string>();
  const respondToLookup = new Map<string, RespondToMode>();
  for (const agent of agents) {
    const key = agent.pubkey.toLowerCase();
    respondToLookup.set(key, agent.respondTo);
    const personaName = agent.personaId
      ? personaById.get(agent.personaId)
      : null;
    if (personaName) personaLookup.set(key, personaName);
  }
  return { personaLookup, respondToLookup };
}
