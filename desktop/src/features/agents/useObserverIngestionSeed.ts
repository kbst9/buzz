import * as React from "react";

import { useVerifiedAgents } from "@/features/agents/lib/useVerifiedAgents";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { UserSearchResult } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

type DirectoryUser = Pick<
  UserSearchResult,
  "pubkey" | "ownerPubkey" | "isAgent"
>;

/**
 * Pure selection core of `useObserverIngestionSeed`, extracted for tests:
 * from community directory rows, the pubkeys of agents whose declared
 * NIP-OA `ownerPubkey` is the current identity. Output is normalized,
 * deduped, and sorted so the derived batch-query key stays stable across
 * directory refetches. Undefined rows/inputs are tolerated — the directory
 * query resolves later than identity on cold boot and vice versa.
 */
export function selectOwnedConnectedAgentPubkeys(
  users: readonly (DirectoryUser | undefined)[] | undefined,
  currentPubkey: string | null | undefined,
): string[] {
  if (!users || !currentPubkey) {
    return [];
  }
  const me = normalizePubkey(currentPubkey);
  const owned = new Set<string>();
  for (const user of users) {
    if (
      user?.isAgent !== true ||
      typeof user.pubkey !== "string" ||
      !user.ownerPubkey
    ) {
      continue;
    }
    if (normalizePubkey(user.ownerPubkey) === me) {
      owned.add(normalizePubkey(user.pubkey));
    }
  }
  return [...owned].sort();
}

/**
 * Cold-start decrypt seed for owned connected (standalone harness) agents.
 *
 * `useAgentObserverIngestion` widens its registration list by *reading* the
 * per-pubkey profile cache (`collectSeenOwnedAgentPubkeys` scanning
 * `["users-batch-entry", pk]` entries) — it never fetches anything itself.
 * So on a fresh community boot an owned connected agent whose profile no
 * surface (member list, timeline, search) has happened to load yet is
 * invisible to the scan: its kind:24200 observer frames arrive on the
 * owner-addressed subscription but are never registered for decryption
 * until the user wanders somewhere that fetches the profile.
 *
 * This hook closes that gap by deliberately populating the cache once per
 * community boot: it pulls the first page of the community user directory,
 * selects agents whose declared `ownerPubkey` is the current identity, and
 * resolves them through `useUsersBatchQuery` — the same query whose
 * `queryFn` writes the `{ summary, fetchedAt }` entries the ingestion scan
 * watches (see `UsersBatchEntry` in features/profile/hooks.ts). No cache
 * entries are hand-written here: the directory row is only the candidate
 * signal, and the authoritative verified summary lands via the existing
 * batch write path.
 *
 * Best-effort by design: only the first directory page (limit 50) is
 * seeded. Owned agents beyond it still register through the kind:10100
 * relay directory or the moment any surface loads their profile.
 */
export function useObserverIngestionSeed() {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;

  // Shared verified-agent enumeration; the owned-agent selection below keeps
  // this seed's own ownership filter over the raw directory rows.
  const { directoryUsers } = useVerifiedAgents({
    enabled: Boolean(currentPubkey),
  });

  const ownedAgentPubkeys = React.useMemo(
    () => selectOwnedConnectedAgentPubkeys(directoryUsers, currentPubkey),
    [directoryUsers, currentPubkey],
  );

  useUsersBatchQuery(ownedAgentPubkeys, {
    enabled: ownedAgentPubkeys.length > 0,
  });
}
