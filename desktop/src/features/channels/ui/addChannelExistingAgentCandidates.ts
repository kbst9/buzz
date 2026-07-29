import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

/**
 * Structural slice of `UserSearchResult` needed to pick "Existing agents"
 * candidates for the channel "Add agents" dialog. Kept structural so the
 * selection logic stays testable without the full API type surface.
 */
export type ExistingAgentCandidate = {
  pubkey: string;
  displayName: string | null;
  nip05Handle: string | null;
  ownerPubkey: string | null;
  isAgent: boolean;
};

/**
 * Display label for an existing-agent row: display name, then NIP-05 handle,
 * then the canonical truncated pubkey.
 */
export function formatExistingAgentLabel(agent: ExistingAgentCandidate) {
  return (
    agent.displayName?.trim() ||
    agent.nip05Handle?.trim() ||
    truncatePubkey(agent.pubkey)
  );
}

/**
 * Selects the connected agents the "Existing agents" section offers to add
 * to a channel:
 *
 * - keeps only verified agents (`isAgent` derives from the Rust-verified
 *   NIP-OA tag, never a self-authored profile flag),
 * - excludes agents already members of the target channel,
 * - excludes explicitly excluded pubkeys — this desktop's locally managed
 *   agents, whose add flow must run the persona/attach path (a bare
 *   member-add leaves a local managed agent deaf; see the members sidebar),
 * - dedupes by normalized pubkey (first occurrence wins),
 * - sorts viewer-owned agents first, then by label.
 *
 * Ownership is deliberately NOT a filter: who may add an agent to a channel
 * is the relay's decision via each user's `channel_add_policy` on kind:9000
 * (see the rationale in `MembersSidebar.tsx`) — refusals surface as per-row
 * errors instead of pre-hiding teammates' agents.
 */
export function selectAddChannelExistingAgentCandidates<
  T extends ExistingAgentCandidate,
>({
  users,
  memberPubkeys,
  excludedPubkeys = [],
  viewerPubkey = null,
}: {
  users: readonly T[];
  memberPubkeys: Iterable<string>;
  excludedPubkeys?: Iterable<string>;
  viewerPubkey?: string | null;
}): T[] {
  const members = new Set([...memberPubkeys].map(normalizePubkey));
  const excluded = new Set([...excludedPubkeys].map(normalizePubkey));
  const seen = new Set<string>();
  const candidates: T[] = [];

  for (const user of users) {
    const pubkey = normalizePubkey(user.pubkey);
    if (
      !user.isAgent ||
      members.has(pubkey) ||
      excluded.has(pubkey) ||
      seen.has(pubkey)
    ) {
      continue;
    }
    seen.add(pubkey);
    candidates.push(user);
  }

  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  return candidates.sort((left, right) => {
    const leftMine = Boolean(
      viewer &&
        left.ownerPubkey &&
        normalizePubkey(left.ownerPubkey) === viewer,
    );
    const rightMine = Boolean(
      viewer &&
        right.ownerPubkey &&
        normalizePubkey(right.ownerPubkey) === viewer,
    );
    if (leftMine !== rightMine) {
      return leftMine ? -1 : 1;
    }
    return formatExistingAgentLabel(left).localeCompare(
      formatExistingAgentLabel(right),
    );
  });
}
