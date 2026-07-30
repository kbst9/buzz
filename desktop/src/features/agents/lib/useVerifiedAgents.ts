/**
 * The community's VERIFIED agents — identities whose `isAgent` flag derives
 * from the Rust-verified NIP-OA auth tag, enumerated from the first page of
 * the community user directory. Connected (standalone-harness) agents appear
 * in neither the managed list nor the kind:10100 relay directory, so this
 * directory sweep is their only enumeration source.
 *
 * This hook is the single shared copy of that enumeration
 * (`useInfiniteUserSearchQuery("", { allowEmpty: true, limit: 50 })` +
 * flatten + `isAgent === true`), previously duplicated across the
 * connected-agent surfaces. Callers keep their own filtering and sorting —
 * only the enumeration and its pubkey dedupe live here.
 *
 * Best-effort by design: one directory page (limit 50). Surfaces that page
 * further keep doing so through `directoryQuery`.
 */

import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import {
  useFlattenedUserSearchResults,
  useInfiniteUserSearchQuery,
} from "@/features/profile/hooks";
import type { UserSearchResult } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** First-page size shared by every verified-agent enumeration surface. */
export const VERIFIED_AGENT_DIRECTORY_LIMIT = 50;

export type UseVerifiedAgentsOptions = {
  /** Gate the underlying directory query (e.g. only while a dialog is open). */
  enabled?: boolean;
  /**
   * Drop agents this desktop manages locally. Surfaces listing CONNECTED
   * agents opt in so managed identities stay under their managed entry
   * instead of being re-offered as connected.
   */
  excludeManaged?: boolean;
};

export type UseVerifiedAgentsResult = {
  /**
   * Verified agents, deduped by normalized pubkey (first directory row
   * wins), managed agents excluded when `excludeManaged` is set.
   */
  agents: UserSearchResult[];
  /** Normalized pubkey → verified agent row; same rows as `agents`. */
  byPubkey: ReadonlyMap<string, UserSearchResult>;
  /**
   * The underlying directory query for loading/paging state
   * (`isLoading`, `isError`, `hasNextPage`, `fetchNextPage`, …).
   */
  directoryQuery: ReturnType<typeof useInfiniteUserSearchQuery>;
  /** Every enumerated directory row — agents and humans alike. */
  directoryUsers: UserSearchResult[];
  /** Normalized pubkeys of this desktop's managed agents. */
  managedPubkeys: ReadonlySet<string>;
};

/**
 * Upper bound on auto-fetched directory pages (pages × limit rows). Agents
 * sort among ALL community rows, so a single page silently truncates any
 * agent past the first 50 — communities with accumulated identities lost
 * later-alphabet agents from every picker fed by this hook.
 */
const MAX_DIRECTORY_PAGES = 10;

export function useVerifiedAgents(
  options?: UseVerifiedAgentsOptions,
): UseVerifiedAgentsResult {
  const directoryQuery = useInfiniteUserSearchQuery("", {
    allowEmpty: true,
    enabled: options?.enabled,
    limit: VERIFIED_AGENT_DIRECTORY_LIMIT,
  });
  const directoryUsers = useFlattenedUserSearchResults(directoryQuery.data);

  // Exhaust the directory (bounded) instead of stopping at page one — the
  // enumeration is only correct once every community row has been seen.
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = directoryQuery;
  const pageCount = directoryQuery.data?.pages.length ?? 0;
  React.useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && pageCount < MAX_DIRECTORY_PAGES) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, pageCount]);
  const managedAgentsQuery = useManagedAgentsQuery();

  const managedPubkeys = React.useMemo(
    () =>
      new Set(
        (managedAgentsQuery.data ?? []).map((agent) =>
          normalizePubkey(agent.pubkey),
        ),
      ),
    [managedAgentsQuery.data],
  );

  const excludeManaged = options?.excludeManaged === true;
  const byPubkey = React.useMemo(() => {
    const map = new Map<string, UserSearchResult>();
    for (const user of directoryUsers) {
      if (user.isAgent !== true) {
        continue;
      }
      const pubkey = normalizePubkey(user.pubkey);
      if (map.has(pubkey) || (excludeManaged && managedPubkeys.has(pubkey))) {
        continue;
      }
      map.set(pubkey, user);
    }
    return map;
  }, [directoryUsers, excludeManaged, managedPubkeys]);

  const agents = React.useMemo(() => [...byPubkey.values()], [byPubkey]);

  return { agents, byPubkey, directoryQuery, directoryUsers, managedPubkeys };
}
