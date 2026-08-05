import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useActiveAgentTurnsBridge } from "@/features/agents/activeAgentTurnsStore";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useManagedAgentObserverBridge } from "@/features/agents/observerRelayStore";
import { useObserverIngestionSeed } from "@/features/agents/useObserverIngestionSeed";
import { useRelayMembersQuery } from "@/features/community-members/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type {
  ManagedAgent,
  RelayMember,
  UserProfileSummary,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Pure selection core, extracted for tests: `bot` roster rows whose
 * claim-time owner is the current identity, as `pubkey → owner` (both
 * normalized). The NIP-43 roster is the relay-authoritative agent source —
 * invite-flow agents carry no NIP-OA profile tag, so the roster row is the
 * ONLY ownership signal that exists for them, and observer registration
 * must not depend on any profile-lane overlay having run first.
 */
export function selectRosterOwnedAgents(
  members: readonly RelayMember[] | undefined,
  currentPubkey: string | null | undefined,
): ReadonlyMap<string, string> {
  const owned = new Map<string, string>();
  if (!members || !currentPubkey) {
    return owned;
  }
  const me = normalizePubkey(currentPubkey);
  for (const member of members) {
    if (member.role !== "bot" || !member.agentOwnerPubkey) {
      continue;
    }
    const owner = normalizePubkey(member.agentOwnerPubkey);
    if (owner === me) {
      owned.set(normalizePubkey(member.pubkey), owner);
    }
  }
  return owned;
}

type IngestionAgent = Pick<ManagedAgent, "pubkey" | "status">;

/** How often observer ingestion re-reads the NIP-43 roster (kind 13534). */
const ROSTER_REFRESH_INTERVAL_MS = 60_000;

/**
 * Combine locally managed agents with relay agents the current identity
 * declared-owns (NIP-OA `ownerPubkey == me`) into one ingestion list.
 *
 * Managed agents keep their real status; owned relay agents that are not
 * managed locally are treated as `deployed` so the observer subscription
 * starts and their frames decrypt. Registering non-owned agents would be
 * pointless — observer frames are `#p`-addressed to the owner, so frames for
 * agents we do not own never arrive on our subscription in the first place.
 */
export function combineObserverIngestionAgents(
  managedAgents: readonly IngestionAgent[],
  relayAgentPubkeys: readonly string[],
  ownerByPubkey: ReadonlyMap<string, string>,
  currentPubkey: string | null | undefined,
): IngestionAgent[] {
  const managed = managedAgents.map((agent) => ({
    pubkey: agent.pubkey,
    status: agent.status,
  }));
  if (!currentPubkey) {
    return managed;
  }

  const managedSet = new Set(
    managed.map((agent) => normalizePubkey(agent.pubkey)),
  );
  const me = normalizePubkey(currentPubkey);
  const owned: IngestionAgent[] = [];
  for (const pubkey of relayAgentPubkeys) {
    const key = normalizePubkey(pubkey);
    if (managedSet.has(key)) {
      continue;
    }
    const owner = ownerByPubkey.get(key);
    if (owner && normalizePubkey(owner) === me) {
      owned.push({ pubkey, status: "deployed" as const });
    }
  }
  return [...managed, ...owned];
}

/**
 * Owned-agent pubkeys the app has verifiably *seen*: every per-pubkey
 * profile cache entry (`["users-batch-entry", pk]`) whose verified NIP-OA
 * `ownerPubkey` is the current identity.
 *
 * This is the enumeration source the kind:10100 directory cannot provide —
 * standalone harness agents never publish 10100, but their profiles flow
 * through the same batch cache the moment any surface (member list,
 * timeline, search) loads them. Their observer frames are `#p`-addressed to
 * the owner and already arrive on the subscription; this hook is what gets
 * them *registered* so they decrypt.
 */
/**
 * Pure core of `useSeenOwnedAgentPubkeys`, extracted for tests: the cache
 * stores `{ summary, fetchedAt }` WRAPPERS under `["users-batch-entry", pk]`
 * (see `UsersBatchEntry` in features/profile/hooks.ts) — reading the bare
 * summary shape here once made the whole widening a silent no-op, which is
 * why this stays a tested seam.
 */
export function collectSeenOwnedAgentPubkeys(
  entries: ReadonlyArray<
    readonly [
      readonly unknown[],
      { summary?: UserProfileSummary | null } | undefined,
    ]
  >,
  currentPubkey: string,
): string[] {
  const me = normalizePubkey(currentPubkey);
  const owned = new Set<string>();
  for (const [queryKey, entry] of entries) {
    const pubkey = queryKey[1];
    const ownerPubkey = entry?.summary?.ownerPubkey;
    if (typeof pubkey !== "string" || !ownerPubkey) {
      continue;
    }
    if (normalizePubkey(ownerPubkey) === me) {
      owned.add(normalizePubkey(pubkey));
    }
  }
  return [...owned].sort();
}

function useSeenOwnedAgentPubkeys(
  currentPubkey: string | null | undefined,
): readonly string[] {
  const queryClient = useQueryClient();
  const [pubkeys, setPubkeys] = React.useState<readonly string[]>([]);

  React.useEffect(() => {
    if (!currentPubkey) {
      setPubkeys([]);
      return;
    }
    const me = currentPubkey;

    const collect = () => {
      const entries = queryClient.getQueriesData<{
        summary?: UserProfileSummary | null;
      }>({
        queryKey: ["users-batch-entry"],
      });
      const next = collectSeenOwnedAgentPubkeys(entries, me);
      setPubkeys((prev) =>
        prev.length === next.length &&
        prev.every((pubkey, index) => pubkey === next[index])
          ? prev
          : next,
      );
    };

    // Batch resolution writes one cache entry per pubkey; coalesce the
    // per-event storm into one scan per tick instead of O(N) scans per
    // N-profile batch.
    let scheduled = false;
    const scheduleCollect = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      window.setTimeout(() => {
        scheduled = false;
        collect();
      }, 0);
    };

    collect();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === "users-batch-entry") {
        scheduleCollect();
      }
    });
    return unsubscribe;
  }, [currentPubkey, queryClient]);

  return pubkeys;
}

/**
 * App-level owner-global observer ingestion.
 *
 * Mounted once in AppShell so observer frames (kind 24200) are received,
 * decrypted, and folded into the derived active-turns store regardless of
 * which screen or panel happens to be open. Individual surfaces read from the
 * stores; none of them need to mount their own bridge for ingestion to work.
 *
 * This is the product invariant: if the current identity owns an agent (local
 * managed agent or declared-owned relay agent), its turn activity is ingested
 * app-wide — not only while a panel that happens to mount a bridge is open.
 *
 * Mounts before identity resolves by design: while `currentPubkey` is still
 * `undefined`, `combineObserverIngestionAgents` returns managed agents only,
 * and relay-owned agents are folded in on the render after identity arrives.
 * Do not gate this hook on identity/startup readiness — that would drop
 * managed-agent observer coverage during startup.
 */
export function useAgentObserverIngestion() {
  // Cold-start seed: primes the batch-profile cache with owned connected
  // agents from the community directory, so the cache scan below has
  // candidates before any other surface happens to load their profiles.
  useObserverIngestionSeed();
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;

  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgents = managedAgentsQuery.data;

  const relayAgentsQuery = useRelayAgentsQuery();
  // Poll the roster: invite-flow agents have no NIP-OA profile, so this query
  // is their ONLY registration source — and this hook is mounted for the app's
  // lifetime, so a one-shot fetch that races startup (or predates a roster
  // change like a member→bot reclassification) would otherwise stay wrong
  // forever and every observer frame from the agent would be dropped unseen.
  const relayMembersQuery = useRelayMembersQuery(
    Boolean(currentPubkey),
    ROSTER_REFRESH_INTERVAL_MS,
  );
  const rosterOwnedAgents = React.useMemo(
    () => selectRosterOwnedAgents(relayMembersQuery.data, currentPubkey),
    [relayMembersQuery.data, currentPubkey],
  );
  const seenOwnedPubkeys = useSeenOwnedAgentPubkeys(currentPubkey);
  const candidatePubkeys = React.useMemo(
    () => [
      ...new Set([
        ...(relayAgentsQuery.data ?? []).map((agent) =>
          normalizePubkey(agent.pubkey),
        ),
        // Invite-flow agents from the NIP-43 roster (`bot` rows owned by
        // the current identity) — the relay-authoritative source.
        ...rosterOwnedAgents.keys(),
        // Verified-owned agents outside the 10100 directory (standalone
        // harness deployments) — see useSeenOwnedAgentPubkeys.
        ...seenOwnedPubkeys,
      ]),
    ],
    [relayAgentsQuery.data, rosterOwnedAgents, seenOwnedPubkeys],
  );

  const profilesQuery = useUsersBatchQuery(candidatePubkeys, {
    enabled: Boolean(currentPubkey) && candidatePubkeys.length > 0,
  });
  const profiles = profilesQuery.data?.profiles;

  const ingestionAgents = React.useMemo(() => {
    // Roster ownership first, so a verified NIP-OA profile summary (below)
    // wins whenever both sources know the agent.
    const ownerByPubkey = new Map<string, string>(rosterOwnedAgents);
    for (const [pubkey, summary] of Object.entries(profiles ?? {})) {
      if (summary.ownerPubkey) {
        // Store both key and value normalized so lookups and ownership
        // comparisons never depend on the casing the relay happened to send.
        ownerByPubkey.set(
          normalizePubkey(pubkey),
          normalizePubkey(summary.ownerPubkey),
        );
      }
    }
    return combineObserverIngestionAgents(
      managedAgents ?? [],
      candidatePubkeys,
      ownerByPubkey,
      currentPubkey,
    );
  }, [
    candidatePubkeys,
    currentPubkey,
    managedAgents,
    profiles,
    rosterOwnedAgents,
  ]);

  useManagedAgentObserverBridge(ingestionAgents);
  useActiveAgentTurnsBridge(ingestionAgents);
}
