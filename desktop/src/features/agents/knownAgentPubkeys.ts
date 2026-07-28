import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Pure merge behind `useKnownAgentPubkeys`: managed agents ∪ relay agents,
 * normalised via `normalizePubkey` so membership checks work against
 * normalised pubkeys.
 *
 * Structurally typed on `{ pubkey }` so node unit tests don't need to build
 * full `ManagedAgent`/`RelayAgent` values.
 */
export function mergeKnownAgentPubkeys(
  managedAgents: readonly { pubkey: string }[] | undefined,
  relayAgents: readonly { pubkey: string }[] | undefined,
): ReadonlySet<string> {
  const pubkeys = new Set<string>();
  for (const agent of managedAgents ?? []) {
    pubkeys.add(normalizePubkey(agent.pubkey));
  }
  for (const agent of relayAgents ?? []) {
    pubkeys.add(normalizePubkey(agent.pubkey));
  }
  return pubkeys;
}

/** Agent identities controlled by the current user. */
export function mergeOwnedAgentPubkeys(
  managedAgents: readonly { pubkey: string }[] | undefined,
  profiles:
    | Readonly<Record<string, { ownerPubkey?: string | null }>>
    | undefined,
  currentPubkey: string | null | undefined,
): ReadonlySet<string> {
  const pubkeys = new Set<string>();
  for (const agent of managedAgents ?? []) {
    pubkeys.add(normalizePubkey(agent.pubkey));
  }

  if (!currentPubkey) return pubkeys;

  const ownerPubkey = normalizePubkey(currentPubkey);
  for (const [pubkey, profile] of Object.entries(profiles ?? {})) {
    if (
      profile.ownerPubkey &&
      normalizePubkey(profile.ownerPubkey) === ownerPubkey
    ) {
      pubkeys.add(normalizePubkey(pubkey));
    }
  }

  return pubkeys;
}

/**
 * Channel-scoped variant: the managed ∪ relay baseline plus this channel's
 * bot members (role `bot` or `isAgent`), so member-only agents are included.
 *
 * `profiles` (when provided) contributes the verified NIP-OA signal: a
 * member whose kind:0 carries a valid auth tag is an agent regardless of
 * its channel role — standalone harness agents join as plain `member` and
 * would otherwise pass as humans.
 */
export function mergeChannelKnownAgentPubkeys(
  channelMembers:
    | readonly { pubkey: string; role: string; isAgent: boolean }[]
    | undefined,
  managedAgents: readonly { pubkey: string }[] | undefined,
  relayAgents: readonly { pubkey: string }[] | undefined,
  profiles?: Readonly<Record<string, { isAgent?: boolean }>>,
): ReadonlySet<string> {
  const pubkeys = new Set(mergeKnownAgentPubkeys(managedAgents, relayAgents));
  for (const member of channelMembers ?? []) {
    const normalized = normalizePubkey(member.pubkey);
    if (
      member.role === "bot" ||
      member.isAgent ||
      profiles?.[normalized]?.isAgent === true
    ) {
      pubkeys.add(normalized);
    }
  }
  return pubkeys;
}
