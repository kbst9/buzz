import * as React from "react";

import type { ActiveChannelTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import { useWorkingChannels } from "@/features/agents/agentWorkingSignal";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Resolve a working-channel summary's agent pubkeys to display names.
 *
 * Managed-agent names win (local source of truth); `fallbackNamesByPubkey`
 * (keyed by normalized pubkey) covers non-managed agents, e.g. from the
 * batch profile cache. Pubkeys resolved by neither are omitted, preserving
 * the consumer's "N agents working" degradation.
 */
export function resolveActiveWorkingChannelNames(
  summary: ActiveChannelTurnSummary,
  managedAgents: readonly { pubkey: string; name: string }[],
  fallbackNamesByPubkey?: ReadonlyMap<string, string>,
): ActiveChannelTurnSummary {
  const namesByPubkey = new Map(
    managedAgents.map((agent) => [normalizePubkey(agent.pubkey), agent.name]),
  );

  return {
    ...summary,
    agentNames: summary.agentPubkeys.flatMap((pubkey) => {
      const normalized = normalizePubkey(pubkey);
      const name =
        namesByPubkey.get(normalized) ?? fallbackNamesByPubkey?.get(normalized);
      return name ? [name] : [];
    }),
  };
}

export function useActiveWorkingChannelsById(): ReadonlyMap<
  string,
  ActiveChannelTurnSummary
> {
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgents = React.useMemo(
    () => managedAgentsQuery.data ?? [],
    [managedAgentsQuery.data],
  );

  // Unified working signal: observer-derived turns primary, bot typing as
  // fallback — so the sidebar badge appears even for agents whose observer
  // stream is absent for this build/scope.
  const activeWorkingChannels = useWorkingChannels();

  // Non-managed working agents (connected/standalone) have no managed-agent
  // record, so their tooltip degraded to "1 agent working". Resolve those
  // pubkeys through the batch profile cache instead.
  const unmanagedWorkingPubkeys = React.useMemo(() => {
    const managedPubkeys = new Set(
      managedAgents.map((agent) => normalizePubkey(agent.pubkey)),
    );
    const pubkeys = new Set<string>();
    for (const summary of activeWorkingChannels) {
      for (const pubkey of summary.agentPubkeys) {
        const normalized = normalizePubkey(pubkey);
        if (!managedPubkeys.has(normalized)) {
          pubkeys.add(normalized);
        }
      }
    }
    return [...pubkeys];
  }, [activeWorkingChannels, managedAgents]);

  const profilesQuery = useUsersBatchQuery(unmanagedWorkingPubkeys);
  const profiles = profilesQuery.data?.profiles;
  const profileNamesByPubkey = React.useMemo(() => {
    const names = new Map<string, string>();
    for (const [pubkey, profile] of Object.entries(profiles ?? {})) {
      const displayName = profile.displayName?.trim();
      if (displayName) {
        names.set(normalizePubkey(pubkey), displayName);
      }
    }
    return names;
  }, [profiles]);

  return React.useMemo(
    () =>
      new Map(
        activeWorkingChannels.map((summary) => {
          const resolvedSummary = resolveActiveWorkingChannelNames(
            summary,
            managedAgents,
            profileNamesByPubkey,
          );
          return [resolvedSummary.channelId, resolvedSummary];
        }),
      ),
    [activeWorkingChannels, managedAgents, profileNamesByPubkey],
  );
}
