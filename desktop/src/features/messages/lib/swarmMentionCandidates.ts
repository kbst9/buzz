/**
 * Swarm mention aliasing (docs/swarms.md §2.1): "@devswarm" is a first-class
 * autocomplete candidate with NO identity of its own. Selecting it inserts
 * the swarm's name as visible text and registers the LEADER's pubkey in the
 * ordinary mention map (emitting the leader's p-tag on send) plus a
 * `["swarm", <swarm-id>]` tag built here. The leader's harness enters
 * delegation mode only when its own mention arrives WITH that tag.
 */

import {
  type DirectoryAgentRespondPolicy,
  shouldHideAgentFromMentions,
} from "@/features/agents/lib/agentAutocompleteEligibility";
import { swarmDisplayName } from "@/features/agents/lib/swarmDialogState";
import type { ChannelType } from "@/shared/api/types";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { hasMention } from "./hasMention";
import type { MentionCandidate } from "./mentionCandidates";

/** Tag name carried on messages that address a swarm (buzz-sdk SWARM_TAG). */
export const SWARM_MENTION_TAG = "swarm";

/** The slice of a swarm definition the candidate builder reads. */
export type SwarmMentionSource = {
  id: string;
  name: string;
  leaderPubkey: string;
  members: readonly { pubkey: string }[];
};

/**
 * Build autocomplete candidates for the current user's swarms.
 *
 * Offered only in CHANNEL composers (`channelType === "stream"`, never DMs)
 * and only when the channel's composer can reach the leader: the leader is a
 * channel member, or it survives the existing `shouldHideAgentFromMentions`
 * gate — the same audibility logic ordinary agent mentions use.
 */
export function buildSwarmMentionCandidates({
  swarms,
  channelType,
  currentPubkey,
  directoryAgentsByPubkey,
  memberPubkeys,
  mentionableAgentPubkeys,
  resolveLeaderLabel,
}: {
  swarms: readonly SwarmMentionSource[];
  channelType: ChannelType | null | undefined;
  currentPubkey?: string | null;
  directoryAgentsByPubkey: ReadonlyMap<string, DirectoryAgentRespondPolicy>;
  memberPubkeys: ReadonlySet<string>;
  mentionableAgentPubkeys: ReadonlySet<string>;
  /** Display name for a leader pubkey, when one is known. */
  resolveLeaderLabel: (pubkey: string) => string | null;
}): MentionCandidate[] {
  if (channelType !== "stream") {
    return [];
  }

  const candidates: MentionCandidate[] = [];
  for (const swarm of swarms) {
    const leader = normalizePubkey(swarm.leaderPubkey);
    if (leader === "") {
      continue;
    }
    const leaderIsMember = memberPubkeys.has(leader);
    const leaderAudible =
      leaderIsMember ||
      !shouldHideAgentFromMentions({
        isAgent: true,
        isMember: leaderIsMember,
        pubkey: leader,
        currentPubkey,
        mentionableAgentPubkeys,
        directoryAgentsByPubkey,
      });
    if (!leaderAudible) {
      continue;
    }
    const displayName = swarmDisplayName(
      swarm.name,
      resolveLeaderLabel(leader)?.trim() || truncatePubkey(leader),
    );
    candidates.push({
      kind: "swarm",
      swarmId: swarm.id,
      swarmMemberCount: swarm.members.length,
      // The leader's pubkey: inserting the candidate routes it through the
      // ordinary mention map, so the send emits the leader's p-tag.
      pubkey: leader,
      displayName,
      isMember: leaderIsMember,
      isAgent: true,
    });
  }
  return candidates;
}

/**
 * `["swarm", <id>]` tags for the swarm mentions actually present in the
 * outgoing text — the emission half of §2.1. `swarmMentions` maps inserted
 * display names to swarm ids (the composer's swarm mention map); names no
 * longer in the text emit nothing, and duplicate ids collapse to one tag.
 */
export function buildSwarmMentionTags(
  text: string,
  swarmMentions: ReadonlyMap<string, string>,
): string[][] {
  const tags: string[][] = [];
  const seen = new Set<string>();
  for (const [displayName, swarmId] of swarmMentions) {
    if (!swarmId || seen.has(swarmId) || !hasMention(text, displayName)) {
      continue;
    }
    seen.add(swarmId);
    tags.push([SWARM_MENTION_TAG, swarmId]);
  }
  return tags;
}
