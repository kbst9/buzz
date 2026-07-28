import type { Channel, RelayAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

export function getSharedChannelIds(channels: readonly Channel[] | undefined) {
  return new Set(
    (channels ?? [])
      .filter((channel) => channel.isMember && channel.archivedAt === null)
      .map((channel) => channel.id),
  );
}

export function relayAgentIsSharedWithUser(
  agent: Pick<RelayAgent, "channelIds" | "respondTo" | "respondToAllowlist">,
  sharedChannelIds: ReadonlySet<string>,
  currentPubkey?: string | null,
) {
  const normalizedCurrentPubkey = currentPubkey
    ? normalizePubkey(currentPubkey)
    : null;

  if (agent.respondTo === "allowlist" && normalizedCurrentPubkey) {
    return agent.respondToAllowlist
      .map((pubkey) => normalizePubkey(pubkey))
      .includes(normalizedCurrentPubkey);
  }

  return (
    agent.respondTo === "anyone" &&
    agent.channelIds.some((channelId) => sharedChannelIds.has(channelId))
  );
}

export function getMentionableAgentPubkeys({
  currentPubkey,
  managedAgentPubkeys,
  relayAgents,
  sharedChannelIds,
}: {
  currentPubkey?: string | null;
  managedAgentPubkeys: Iterable<string>;
  relayAgents: readonly RelayAgent[] | undefined;
  sharedChannelIds: ReadonlySet<string>;
}) {
  const pubkeys = new Set(
    [...managedAgentPubkeys].map((pubkey) => normalizePubkey(pubkey)),
  );

  for (const agent of relayAgents ?? []) {
    if (relayAgentIsSharedWithUser(agent, sharedChannelIds, currentPubkey)) {
      pubkeys.add(normalizePubkey(agent.pubkey));
    }
  }

  return pubkeys;
}

export function isAgentIdentityInManagedList(
  candidate: { isAgent?: boolean; pubkey: string },
  managedAgentPubkeys: ReadonlySet<string>,
) {
  return (
    candidate.isAgent !== true ||
    managedAgentPubkeys.has(normalizePubkey(candidate.pubkey))
  );
}

/** The respond_to slice of a kind:10100 relay-directory entry. */
export type DirectoryAgentRespondPolicy = Pick<
  RelayAgent,
  "respondTo" | "respondToAllowlist"
>;

export function shouldHideAgentFromMentions({
  isAgent,
  isMember,
  pubkey,
  currentPubkey,
  mentionableAgentPubkeys,
  directoryAgentsByPubkey,
}: {
  isAgent: boolean;
  isMember: boolean;
  pubkey: string;
  currentPubkey?: string | null;
  mentionableAgentPubkeys: ReadonlySet<string>;
  directoryAgentsByPubkey: ReadonlyMap<string, DirectoryAgentRespondPolicy>;
}) {
  if (!isAgent) return false;
  const normalized = normalizePubkey(pubkey);
  // Invocable => always show.
  if (mentionableAgentPubkeys.has(normalized)) return false;
  // Non-member, non-invocable => hide (preserves prior behavior).
  if (!isMember) return true;
  // Member (Option B): hide only on an explicit won't-respond-to-me signal.
  // The only kind:10100 fact with trustworthy exclusion semantics is a
  // populated allowlist that leaves the current user out. Everything else is
  // unknown, and unknown members show:
  //  - no directory entry, or `respondTo: null` — `buzz channels
  //    set-add-policy` publishes kind:10100 without respond_to/channel_ids,
  //    so directory presence alone says nothing about invocability;
  //  - "anyone" — a co-member of this channel responds to us even when the
  //    entry's channel_ids are stale or empty;
  //  - "owner-only" — ownership is not reliably knowable client-side (an
  //    agent hosted off this machine may still be ours).
  // Whether the agent actually answers stays the harness's decision
  // (respond_to gate, default owner-only) — the same shape as the relay
  // owning channel adds (kind:9000 + channel_add_policy).
  //
  // NOTE: `directoryAgentsByPubkey` and `mentionableAgentPubkeys` must stay
  // derived from the same source query (`relayAgentsQuery.data`): an
  // allowlist that includes the current user is meant to be caught by the
  // invocable check above, so a lagging mentionable set would briefly hide
  // an agent its own allowlist admits.
  const directoryEntry = directoryAgentsByPubkey.get(normalized);
  if (directoryEntry?.respondTo !== "allowlist" || !currentPubkey) {
    return false;
  }
  const normalizedCurrentPubkey = normalizePubkey(currentPubkey);
  return !directoryEntry.respondToAllowlist.some(
    (allowed) => normalizePubkey(allowed) === normalizedCurrentPubkey,
  );
}

type AgentAutocompleteCandidate = {
  pubkey?: string;
  displayName?: string | null;
  ownerPubkey?: string | null;
  isAgent?: boolean;
  isManagedAgent?: boolean;
  isMember?: boolean;
  personaId?: string | null;
};

function normalizeLabel(label: string | null | undefined) {
  return label?.trim().toLowerCase() || null;
}

function agentIdentityKey<T extends AgentAutocompleteCandidate>(
  candidate: T,
  currentPubkey: string | null | undefined,
  getLabel: (candidate: T) => string | null | undefined,
) {
  if (candidate.isAgent !== true) {
    return null;
  }

  if (candidate.personaId) {
    return `persona:${candidate.personaId}`;
  }

  const label = normalizeLabel(getLabel(candidate));
  if (!label) {
    return null;
  }

  const ownerPubkey = candidate.ownerPubkey
    ? normalizePubkey(candidate.ownerPubkey)
    : null;
  if (ownerPubkey) {
    if (currentPubkey && ownerPubkey === normalizePubkey(currentPubkey)) {
      return `local:name:${label}`;
    }
    return `owner:${ownerPubkey}:name:${label}`;
  }

  return null;
}

function agentCandidateRank<T extends AgentAutocompleteCandidate>(
  candidate: T,
  currentPubkey: string | null | undefined,
  preferredPubkeys: ReadonlySet<string>,
) {
  const pubkey = candidate.pubkey ? normalizePubkey(candidate.pubkey) : null;
  const ownerPubkey = candidate.ownerPubkey
    ? normalizePubkey(candidate.ownerPubkey)
    : null;
  const normalizedCurrentPubkey = currentPubkey
    ? normalizePubkey(currentPubkey)
    : null;

  return [
    candidate.isMember === true ? 0 : 1,
    pubkey && preferredPubkeys.has(pubkey) ? 0 : 1,
    candidate.isManagedAgent === true ? 0 : 1,
    candidate.personaId ? 0 : 1,
    ownerPubkey && ownerPubkey === normalizedCurrentPubkey ? 0 : 1,
  ];
}

function isPreferredAgentCandidate<T extends AgentAutocompleteCandidate>(
  next: T,
  current: T,
  currentPubkey: string | null | undefined,
  preferredPubkeys: ReadonlySet<string>,
) {
  const nextRank = agentCandidateRank(next, currentPubkey, preferredPubkeys);
  const currentRank = agentCandidateRank(
    current,
    currentPubkey,
    preferredPubkeys,
  );

  for (let index = 0; index < nextRank.length; index++) {
    if (nextRank[index] !== currentRank[index]) {
      return nextRank[index] < currentRank[index];
    }
  }

  return false;
}

export function coalesceAutocompleteCandidatesByKey<T>(
  candidates: readonly T[],
  getKey: (candidate: T) => string | null,
) {
  const output: T[] = [];
  const indexesByKey = new Map<string, number>();

  for (const candidate of candidates) {
    const key = getKey(candidate);
    if (!key) {
      output.push(candidate);
      continue;
    }

    if (!indexesByKey.has(key)) {
      indexesByKey.set(key, output.length);
      output.push(candidate);
    }
  }

  return output;
}

export function coalesceAgentAutocompleteCandidates<
  T extends AgentAutocompleteCandidate,
>(
  candidates: readonly T[],
  {
    currentPubkey,
    getLabel,
    preferredPubkeys = new Set(),
  }: {
    currentPubkey?: string | null;
    getLabel: (candidate: T) => string | null | undefined;
    preferredPubkeys?: ReadonlySet<string>;
  },
) {
  const output: T[] = [];
  const indexesByKey = new Map<string, number>();

  for (const candidate of candidates) {
    const key = agentIdentityKey(candidate, currentPubkey, getLabel);
    if (!key) {
      output.push(candidate);
      continue;
    }

    const currentIndex = indexesByKey.get(key);
    if (currentIndex === undefined) {
      indexesByKey.set(key, output.length);
      output.push(candidate);
      continue;
    }

    if (
      isPreferredAgentCandidate(
        candidate,
        output[currentIndex],
        currentPubkey,
        preferredPubkeys,
      )
    ) {
      output[currentIndex] = candidate;
    }
  }

  return output;
}
