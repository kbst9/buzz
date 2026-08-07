/**
 * Pure row-state management for the swarm create/edit dialog — member-row
 * add/remove/update, per-row dropdown option filtering, draft validation,
 * and the agent-option merge (managed ∪ verified). No app imports beyond
 * the pubkey normalizer so node tests can exercise everything directly.
 */

import { coalesceAgentAutocompleteCandidates } from "@/features/agents/lib/agentAutocompleteEligibility";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import type { SwarmMemberDefinition } from "./swarmDefinitionContent";

/** One editable member row. `key` is a stable render key, never reused. */
export type SwarmMemberRow = {
  key: number;
  /** Normalized pubkey; empty while the row's agent is still unpicked. */
  pubkey: string;
  description: string;
};

/** A pickable agent for the leader/member dropdowns. */
export type SwarmAgentOption = {
  /** Normalized pubkey. */
  pubkey: string;
  label: string;
  avatarUrl: string | null;
};

type ManagedAgentLike = {
  pubkey: string;
  name: string;
  avatarUrl: string | null;
};

type VerifiedAgentLike = {
  pubkey: string;
  displayName: string | null;
  nip05Handle: string | null;
  avatarUrl: string | null;
  ownerPubkey?: string | null;
};

/**
 * Merge managed and verified (connected) agents into one dropdown option
 * list — any agent is eligible as leader or member. Deduped by normalized
 * pubkey (the managed record wins for identities present in both). Distinct
 * pubkeys sharing a display name stay separate options (#5202): agent
 * identity is the pubkey, and same-owner same-name agent fleets are proven
 * live — collapsing them made one unpickable as a swarm member.
 * Sorted by label for a stable dropdown order.
 */
export function combineSwarmAgentOptions(
  managedAgents: readonly ManagedAgentLike[],
  verifiedAgents: readonly VerifiedAgentLike[],
  options?: { currentPubkey?: string | null },
): SwarmAgentOption[] {
  type Candidate = SwarmAgentOption & {
    displayName: string;
    ownerPubkey: string | null;
    isAgent: true;
    isManagedAgent: boolean;
  };

  const currentPubkey = options?.currentPubkey ?? null;
  const byPubkey = new Map<string, Candidate>();
  for (const agent of managedAgents) {
    const pubkey = normalizePubkey(agent.pubkey);
    if (!pubkey || byPubkey.has(pubkey)) {
      continue;
    }
    const label = agent.name.trim() || truncatePubkey(pubkey);
    byPubkey.set(pubkey, {
      pubkey,
      label,
      avatarUrl: agent.avatarUrl,
      displayName: label,
      ownerPubkey: currentPubkey ? normalizePubkey(currentPubkey) : null,
      isAgent: true,
      isManagedAgent: true,
    });
  }
  for (const agent of verifiedAgents) {
    const pubkey = normalizePubkey(agent.pubkey);
    if (!pubkey || byPubkey.has(pubkey)) {
      continue;
    }
    const label =
      agent.displayName?.trim() ||
      agent.nip05Handle?.trim() ||
      truncatePubkey(pubkey);
    byPubkey.set(pubkey, {
      pubkey,
      label,
      avatarUrl: agent.avatarUrl,
      displayName: label,
      ownerPubkey: agent.ownerPubkey
        ? normalizePubkey(agent.ownerPubkey)
        : null,
      isAgent: true,
      isManagedAgent: false,
    });
  }

  const coalesced = coalesceAgentAutocompleteCandidates(
    [...byPubkey.values()],
    {
      currentPubkey,
      getLabel: (candidate) => candidate.displayName,
    },
  );

  return coalesced
    .map(({ pubkey, label, avatarUrl }) => ({ pubkey, label, avatarUrl }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Seed member rows from a stored definition. An empty member list yields a
 * single empty row so the section always shows an editable row.
 */
export function memberRowsFromDefinition(
  members: readonly SwarmMemberDefinition[],
  startKey = 0,
): { rows: SwarmMemberRow[]; nextKey: number } {
  if (members.length === 0) {
    return {
      rows: [{ key: startKey, pubkey: "", description: "" }],
      nextKey: startKey + 1,
    };
  }
  return {
    rows: members.map((member, index) => ({
      key: startKey + index,
      pubkey: normalizePubkey(member.pubkey),
      description: member.description,
    })),
    nextKey: startKey + members.length,
  };
}

/** Append an empty member row (the + affordance). */
export function appendEmptyMemberRow(
  rows: readonly SwarmMemberRow[],
  nextKey: number,
): { rows: SwarmMemberRow[]; nextKey: number } {
  return {
    rows: [...rows, { key: nextKey, pubkey: "", description: "" }],
    nextKey: nextKey + 1,
  };
}

/**
 * Remove a member row. Removing the last remaining row leaves one fresh
 * empty row instead of an empty section.
 */
export function removeMemberRow(
  rows: readonly SwarmMemberRow[],
  key: number,
  nextKey: number,
): { rows: SwarmMemberRow[]; nextKey: number } {
  const remaining = rows.filter((row) => row.key !== key);
  if (remaining.length > 0) {
    return { rows: remaining, nextKey };
  }
  return {
    rows: [{ key: nextKey, pubkey: "", description: "" }],
    nextKey: nextKey + 1,
  };
}

/** Patch one member row by key. */
export function updateMemberRow(
  rows: readonly SwarmMemberRow[],
  key: number,
  patch: Partial<Pick<SwarmMemberRow, "pubkey" | "description">>,
): SwarmMemberRow[] {
  return rows.map((row) =>
    row.key === key
      ? {
          ...row,
          ...(patch.pubkey !== undefined
            ? { pubkey: normalizePubkey(patch.pubkey) }
            : {}),
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
        }
      : row,
  );
}

/**
 * Dropdown options for one member row: the leader and agents already picked
 * by OTHER rows are excluded; the row's own current pick stays listed so the
 * closed dropdown keeps displaying it.
 */
export function memberOptionsForRow(
  options: readonly SwarmAgentOption[],
  {
    leaderPubkey,
    rows,
    rowKey,
  }: {
    leaderPubkey: string;
    rows: readonly SwarmMemberRow[];
    rowKey: number;
  },
): SwarmAgentOption[] {
  const leader = normalizePubkey(leaderPubkey);
  const pickedElsewhere = new Set(
    rows
      .filter((row) => row.key !== rowKey && row.pubkey !== "")
      .map((row) => row.pubkey),
  );
  return options.filter(
    (option) => option.pubkey !== leader && !pickedElsewhere.has(option.pubkey),
  );
}

/**
 * Members a saved definition would carry: rows without an agent pick are
 * dropped; descriptions are kept as typed.
 */
export function rowsToMembers(
  rows: readonly SwarmMemberRow[],
): SwarmMemberDefinition[] {
  return rows
    .filter((row) => row.pubkey !== "")
    .map((row) => ({ pubkey: row.pubkey, description: row.description }));
}

/**
 * Validate a swarm draft for save: a leader must be picked and at least one
 * member row must have an agent. Returns a user-facing error, or null when
 * the draft is savable.
 */
export function validateSwarmDraft({
  leaderPubkey,
  rows,
}: {
  leaderPubkey: string;
  rows: readonly SwarmMemberRow[];
}): string | null {
  if (normalizePubkey(leaderPubkey) === "") {
    return "Choose a leader for this swarm.";
  }
  if (rowsToMembers(rows).length === 0) {
    return "Add at least one member to this swarm.";
  }
  return null;
}

type RespondPolicyLike = {
  respondTo: string | null;
  respondToAllowlist: readonly string[];
};

/**
 * Row-level warning when a selected member's kind:10100 directory entry says
 * it will NOT respond to the leader — the Option B allowlist signal used by
 * `shouldHideAgentFromMentions`: only a populated allowlist that leaves the
 * leader out is a trustworthy exclusion, everything else is unknown and
 * stays silent. Members owned by the swarm owner never warn (the sibling
 * rule admits the leader through their respond gate).
 */
export function memberLeaderWarning({
  directoryEntry,
  leaderPubkey,
  memberOwnerPubkey,
  viewerPubkey,
}: {
  directoryEntry: RespondPolicyLike | undefined;
  leaderPubkey: string;
  memberOwnerPubkey: string | null | undefined;
  viewerPubkey: string | null | undefined;
}): string | null {
  const leader = normalizePubkey(leaderPubkey);
  if (leader === "") {
    return null;
  }
  if (
    viewerPubkey &&
    memberOwnerPubkey &&
    normalizePubkey(memberOwnerPubkey) === normalizePubkey(viewerPubkey)
  ) {
    return null;
  }
  if (directoryEntry?.respondTo !== "allowlist") {
    return null;
  }
  const admitsLeader = directoryEntry.respondToAllowlist.some(
    (allowed) => normalizePubkey(allowed) === leader,
  );
  return admitsLeader
    ? null
    : "This agent's respond list does not include the leader — it may not answer assignments.";
}

/** The §6 default name for a leader: `{Leader}'s swarm`. */
export function defaultSwarmName(leaderLabel: string): string {
  return `${leaderLabel}'s swarm`;
}

/**
 * Display name for a swarm: the owner-chosen name, falling back to
 * "{Leader}'s swarm" when the name was left empty.
 */
export function swarmDisplayName(name: string, leaderLabel: string): string {
  const trimmed = name.trim();
  return trimmed !== "" ? trimmed : defaultSwarmName(leaderLabel);
}
