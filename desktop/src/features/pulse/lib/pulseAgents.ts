import type { ChannelMember } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Profile-shaped lookup rows (batch profiles, user search) keyed by
 * normalized pubkey. `isAgent` on these is derived Rust-side from the
 * verified NIP-OA auth tag, so it is trustworthy for classification.
 */
type ProfileLikeLookup = Readonly<
  Record<
    string,
    { displayName?: string | null; isAgent?: boolean | null } | undefined
  >
>;

/**
 * Union the kind:10100/managed agent pubkeys with verified connected-agent
 * pubkeys (from the community user directory), normalized and deduped.
 * Directory order is preserved: relay/managed agents first, then verified
 * extras.
 */
export function widenAgentPubkeys(
  relayAgentPubkeys: readonly string[],
  verifiedAgentPubkeys: Iterable<string>,
): string[] {
  const seen = new Set<string>();
  const pubkeys: string[] = [];
  for (const pubkey of [...relayAgentPubkeys, ...verifiedAgentPubkeys]) {
    const normalized = normalizePubkey(pubkey);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    pubkeys.push(normalized);
  }
  return pubkeys;
}

/**
 * Classify a note author as an agent: member of the (widened) agent pubkey
 * set OR carrying the verified `isAgent` profile flag. The profile OR keeps
 * classification correct even for agents beyond the first directory page —
 * the batch profile query over visible note authors already fetched them.
 */
export function isAgentNotePubkey(
  pubkey: string,
  agentPubkeySet: ReadonlySet<string>,
  profiles?: ProfileLikeLookup,
): boolean {
  const normalized = normalizePubkey(pubkey);
  if (agentPubkeySet.has(normalized)) {
    return true;
  }
  return profiles?.[normalized]?.isAgent === true;
}

/**
 * Pulse mention rows are channel-member shaped plus an explicit member
 * marker: Pulse is a community-wide composer and directory users ARE
 * community members, so candidates must clear useMentions' non-member gates
 * (managed-list liveness and `shouldHideAgentFromMentions`).
 */
export type PulseMentionMember = ChannelMember & { isMember: true };

/**
 * Build the composer mention candidates for Pulse. Every row carries
 * `isMember: true` (see {@link PulseMentionMember}) and classifies agents
 * via the widened agent set OR the verified profile flag.
 */
export function buildPulseMentionMembers(
  mentionPubkeys: readonly string[],
  profiles: ProfileLikeLookup,
  agentPubkeySet: ReadonlySet<string>,
): PulseMentionMember[] {
  return mentionPubkeys.map((pubkey) => {
    const profile = profiles[normalizePubkey(pubkey)];
    return {
      pubkey,
      role: "member",
      isAgent: isAgentNotePubkey(pubkey, agentPubkeySet, profiles),
      joinedAt: "",
      displayName: profile?.displayName ?? null,
      isMember: true,
    };
  });
}
