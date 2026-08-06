import {
  coalesceAgentAutocompleteCandidates,
  coalesceAutocompleteCandidatesByKey,
  type DirectoryAgentRespondPolicy,
  isAgentIdentityInAllowedList,
  shouldHideAgentFromMentions,
} from "@/features/agents/lib/agentAutocompleteEligibility";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type {
  AgentPersona,
  ChannelMember,
  ManagedAgent,
  RelayAgent,
  UserSearchResult,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  formatSearchUserDisplayName,
  formatSearchUserSecondaryLabel,
  globalSearchIdentityKey,
  type MentionCandidate,
  mentionCandidateLabel,
  mergeMentionCandidates,
} from "./mentionCandidates";

/**
 * Assemble the identity + persona mention candidates for a composer: channel
 * members, relay-directory agents, locally managed agents, global user
 * search hits, and unlinked active personas — deduped per pubkey (later
 * sources merge into earlier ones) and coalesced by identity label. Pure;
 * `useMentions` memoizes the call. Team and swarm candidates are built
 * separately and appended by the caller.
 */
export function buildMentionCandidates({
  activePersonaById,
  activePersonas,
  canSearchGlobalUsers,
  currentPubkey,
  directoryAgentsByPubkey,
  isArchivedDiscovery,
  managedAgentNamesByPubkey,
  managedAgentPersonaIds,
  managedAgentPersonaIdsByPubkey,
  managedAgents,
  memberPubkeys,
  members,
  mentionableAgentPubkeys,
  personaNameByPubkey,
  profiles,
  relayAgentNamesByPubkey,
  relayAgents,
  userSearchResults,
}: {
  activePersonaById: ReadonlyMap<string, AgentPersona>;
  activePersonas: readonly AgentPersona[];
  canSearchGlobalUsers: boolean;
  currentPubkey: string | null;
  directoryAgentsByPubkey: ReadonlyMap<string, DirectoryAgentRespondPolicy>;
  isArchivedDiscovery: (pubkey: string) => boolean;
  managedAgentNamesByPubkey: ReadonlyMap<string, string>;
  managedAgentPersonaIds: ReadonlySet<string>;
  managedAgentPersonaIdsByPubkey: ReadonlyMap<string, string>;
  managedAgents: readonly ManagedAgent[] | undefined;
  memberPubkeys: ReadonlySet<string>;
  members: readonly ChannelMember[] | undefined;
  mentionableAgentPubkeys: ReadonlySet<string>;
  personaNameByPubkey: ReadonlyMap<string, string>;
  profiles?: UserProfileLookup;
  relayAgentNamesByPubkey: ReadonlyMap<string, string>;
  relayAgents: readonly RelayAgent[] | undefined;
  userSearchResults: readonly UserSearchResult[];
}): MentionCandidate[] {
  const candidatesByPubkey = new Map<string, MentionCandidate>();

  const addCandidate = (candidate: MentionCandidate & { pubkey: string }) => {
    const pubkey = normalizePubkey(candidate.pubkey);
    if (isArchivedDiscovery(pubkey)) {
      return;
    }
    // The eligibility gate applies to NON-members only. A member agent was
    // deliberately added to the channel — the relay already vetted that add
    // (kind:9000 + per-user channel_add_policy, see MembersSidebar) — so
    // hiding it here would leave a member that can never be mentioned.
    // Non-member agents must be in the scope-aware allowed set (#4913):
    // locally managed agents plus relay-directory agents that can respond
    // in the current scope.
    if (
      candidate.isMember !== true &&
      !isAgentIdentityInAllowedList(candidate, mentionableAgentPubkeys)
    ) {
      return;
    }
    if (
      shouldHideAgentFromMentions({
        isAgent: candidate.isAgent === true,
        isMember: candidate.isMember === true,
        pubkey,
        currentPubkey,
        mentionableAgentPubkeys,
        directoryAgentsByPubkey,
      })
    ) {
      return;
    }
    const current = candidatesByPubkey.get(pubkey);
    if (!current) {
      candidatesByPubkey.set(pubkey, { ...candidate, pubkey });
      return;
    }

    candidatesByPubkey.set(
      pubkey,
      mergeMentionCandidates(
        current,
        { ...candidate, pubkey },
        profiles?.[pubkey]?.ownerPubkey,
      ),
    );
  };
  for (const member of members ?? []) {
    const pubkey = normalizePubkey(member.pubkey);
    const linkedPersonaId = activePersonaById.has(pubkey) ? pubkey : undefined;
    const agentName =
      managedAgentNamesByPubkey.get(pubkey) ??
      relayAgentNamesByPubkey.get(pubkey) ??
      null;
    const profile = profiles?.[pubkey] ?? null;
    addCandidate({
      kind: "identity",
      pubkey,
      displayName:
        member.displayName?.trim() ||
        agentName ||
        profile?.displayName?.trim() ||
        profile?.nip05Handle?.trim() ||
        null,
      avatarUrl: profile?.avatarUrl ?? null,
      isMember: true,
      personaId: managedAgentPersonaIdsByPubkey.get(pubkey) ?? linkedPersonaId,
      isAgent:
        member.isAgent === true ||
        profile?.isAgent === true ||
        member.role === "bot" ||
        managedAgentNamesByPubkey.has(pubkey) ||
        relayAgentNamesByPubkey.has(pubkey),
      ownerPubkey: profile?.ownerPubkey ?? null,
      personaName: personaNameByPubkey.get(pubkey) ?? null,
      role: member.role,
      secondaryLabel:
        profile?.displayName?.trim() && profile?.nip05Handle?.trim()
          ? profile.nip05Handle
          : null,
    });
  }

  for (const agent of relayAgents ?? []) {
    const pubkey = normalizePubkey(agent.pubkey);
    addCandidate({
      kind: "identity",
      pubkey,
      displayName: agent.name,
      isMember: false,
      personaId:
        managedAgentPersonaIdsByPubkey.get(pubkey) ??
        (activePersonaById.has(pubkey) ? pubkey : undefined),
      ownerPubkey: null,
      isAgent: true,
    });
  }

  for (const agent of managedAgents ?? []) {
    addCandidate({
      kind: "identity",
      pubkey: agent.pubkey,
      displayName: agent.name,
      isMember: false,
      isAgent: true,
      isManagedAgent: true,
      personaId: agent.personaId ?? undefined,
      personaName:
        personaNameByPubkey.get(normalizePubkey(agent.pubkey)) ?? null,
      ownerPubkey: currentPubkey,
    });
  }

  if (canSearchGlobalUsers) {
    for (const user of userSearchResults) {
      const pubkey = normalizePubkey(user.pubkey);
      addCandidate({
        kind: "identity",
        pubkey,
        displayName: formatSearchUserDisplayName(user),
        avatarUrl: user.avatarUrl ?? null,
        personaId:
          managedAgentPersonaIdsByPubkey.get(pubkey) ??
          (activePersonaById.has(pubkey) ? pubkey : undefined),
        isMember: false,
        isAgent:
          user.isAgent ||
          managedAgentNamesByPubkey.has(pubkey) ||
          relayAgentNamesByPubkey.has(pubkey),
        personaName: personaNameByPubkey.get(pubkey) ?? null,
        secondaryLabel: formatSearchUserSecondaryLabel(user),
        ownerPubkey: user.ownerPubkey ?? null,
        isGlobalSearchResult: true,
        isManagedAgent: managedAgentNamesByPubkey.has(pubkey),
      });
    }
  }

  const personaCandidates: MentionCandidate[] = activePersonas
    .filter((persona) => !managedAgentPersonaIds.has(persona.id))
    .map((persona) => ({
      kind: "persona" as const,
      personaId: persona.id,
      displayName: persona.displayName,
      avatarUrl: persona.avatarUrl,
      isMember: false,
      isAgent: true,
    }))
    .filter((candidate) => candidate.displayName.trim().length > 0);

  return coalesceAgentAutocompleteCandidates(
    coalesceAutocompleteCandidatesByKey(
      [...candidatesByPubkey.values(), ...personaCandidates],
      globalSearchIdentityKey,
    ),
    {
      currentPubkey,
      getLabel: mentionCandidateLabel,
      preferredPubkeys: memberPubkeys,
    },
  );
}
