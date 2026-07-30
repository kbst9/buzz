/**
 * Composer-side swarm mention aliasing (docs/swarms.md §2.1), bundled into
 * one hook so `useMentions` stays a thin integration: the owner-swarms
 * query (channel composers only — never DMs), the per-swarm autocomplete
 * candidates, the inserted-alias → swarm-id map, selection bookkeeping, and
 * send-time `["swarm", <id>]` tag emission. The LEADER's p-tag is not
 * handled here — inserting a swarm candidate routes the leader's pubkey
 * through the ordinary mention map in `useMentions`.
 */

import * as React from "react";

import type { DirectoryAgentRespondPolicy } from "@/features/agents/lib/agentAutocompleteEligibility";
import { useSwarmsQuery } from "@/features/agents/lib/swarmDefinition";
import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ChannelType } from "@/shared/api/types";
import { trimMapToSize } from "@/shared/lib/trimMapToSize";
import {
  buildSwarmMentionCandidates,
  buildSwarmMentionTags,
} from "./swarmMentionCandidates";

export function useSwarmMentionAliasing({
  channelType,
  currentPubkey,
  directoryAgentsByPubkey,
  managedAgentNamesByPubkey,
  memberPubkeys,
  mentionableAgentPubkeys,
  profiles,
  relayAgentNamesByPubkey,
}: {
  channelType: ChannelType | null;
  currentPubkey: string | null;
  directoryAgentsByPubkey: ReadonlyMap<string, DirectoryAgentRespondPolicy>;
  managedAgentNamesByPubkey: ReadonlyMap<string, string>;
  memberPubkeys: ReadonlySet<string>;
  mentionableAgentPubkeys: ReadonlySet<string>;
  profiles?: UserProfileLookup;
  relayAgentNamesByPubkey: ReadonlyMap<string, string>;
}) {
  // Swarm aliasing is offered only in channel composers (never DMs), so the
  // owner-swarms fetch stays disabled everywhere else.
  const swarmsQuery = useSwarmsQuery(
    channelType === "stream" ? (currentPubkey ?? undefined) : undefined,
  );
  // Inserted swarm display name → swarm id. The leader pubkey rides the
  // ordinary mention map; this map only feeds the ["swarm", id] tag.
  const swarmMentionMapRef = React.useRef<Map<string, string>>(new Map());

  // One candidate per owned swarm whose leader this channel can reach.
  // Selecting one inserts the swarm name and routes the LEADER's p-tag
  // through the ordinary mention map plus a ["swarm", id] tag.
  const swarmMentionCandidates = React.useMemo(
    () =>
      buildSwarmMentionCandidates({
        swarms: swarmsQuery.data ?? [],
        channelType,
        currentPubkey,
        directoryAgentsByPubkey,
        memberPubkeys,
        mentionableAgentPubkeys,
        resolveLeaderLabel: (pubkey) =>
          managedAgentNamesByPubkey.get(pubkey) ??
          relayAgentNamesByPubkey.get(pubkey) ??
          profiles?.[pubkey]?.displayName?.trim() ??
          null,
      }),
    [
      channelType,
      currentPubkey,
      directoryAgentsByPubkey,
      managedAgentNamesByPubkey,
      memberPubkeys,
      mentionableAgentPubkeys,
      profiles,
      relayAgentNamesByPubkey,
      swarmsQuery.data,
    ],
  );

  /**
   * Record a completed autocomplete selection. A swarm selection remembers
   * the alias → swarm id so the send adds the ["swarm", id] tag (the
   * leader's p-tag already landed in the ordinary mention map); any other
   * kind reclaiming one of the inserted display names clears a stale entry.
   */
  const noteSwarmSelection = React.useCallback(
    (
      suggestion: MentionSuggestion,
      selectedMentions: readonly { displayName: string }[],
    ) => {
      const swarmMentions = swarmMentionMapRef.current;
      if (
        suggestion.kind === "swarm" &&
        suggestion.swarmId &&
        suggestion.pubkey
      ) {
        swarmMentions.set(suggestion.displayName, suggestion.swarmId);
      } else {
        for (const selected of selectedMentions) {
          swarmMentions.delete(selected.displayName);
        }
      }
      trimMapToSize(swarmMentions, 200);
    },
    [],
  );

  // The ["swarm", <id>] tags for swarm mentions still present in the text —
  // the emission half of §2.1.
  const collectSwarmTags = React.useCallback(
    (text: string): string[][] =>
      buildSwarmMentionTags(text, swarmMentionMapRef.current),
    [],
  );

  return {
    collectSwarmTags,
    noteSwarmSelection,
    swarmMentionCandidates,
    swarmMentionMapRef,
  };
}
