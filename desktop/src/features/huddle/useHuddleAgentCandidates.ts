import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useVerifiedAgents } from "@/features/agents/lib/useVerifiedAgents";
import { usePresenceQuery } from "@/features/presence/hooks";
import type { ManagedAgentBackend, PresenceLookup } from "@/shared/api/types";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

/** Where an offerable huddle agent comes from. */
export type HuddleAgentCandidateSource = "managed" | "connected";

/** An agent the huddle "Add Agent" dialog can offer. */
export type HuddleAgentCandidate = {
  /** Normalized (trimmed, lowercase) hex pubkey. */
  pubkey: string;
  name: string;
  source: HuddleAgentCandidateSource;
  /**
   * Managed running/deployed agents count as online (their process is
   * desktop-controlled); connected agents follow relay presence.
   */
  online: boolean;
  avatarUrl: string | null;
  /** Managed-only: drives the dialog's start-on-add flow. */
  status?: string;
  /** Managed-only: local backends start before add, remote ones after. */
  backend?: ManagedAgentBackend;
};

type ManagedAgentLike = {
  pubkey: string;
  name: string;
  status: string;
  avatarUrl?: string | null;
  backend?: ManagedAgentBackend;
};

type DirectoryUserLike = {
  pubkey: string;
  displayName: string | null;
  avatarUrl?: string | null;
  nip05Handle: string | null;
  isAgent: boolean;
};

/**
 * Merge managed agents and community directory results into the huddle
 * "Add Agent" candidate list:
 *
 * - every managed agent is offered — the dialog starts stopped/undeployed
 *   ones as part of the add flow — and running/deployed ones count as
 *   online;
 * - directory users are offered only when they are verified agents
 *   (`isAgent === true`) and not managed by this desktop — managed pubkeys
 *   stay under their managed entry instead of being re-offered as connected;
 * - pubkeys are normalized and deduped, first entry wins.
 */
export function mergeHuddleAgentCandidates(
  managedAgents: readonly ManagedAgentLike[],
  directoryUsers: readonly DirectoryUserLike[],
  presence?: PresenceLookup,
): HuddleAgentCandidate[] {
  const managedPubkeys = new Set(
    managedAgents.map((agent) => normalizePubkey(agent.pubkey)),
  );
  const seen = new Set<string>();
  const candidates: HuddleAgentCandidate[] = [];

  for (const agent of managedAgents) {
    const pubkey = normalizePubkey(agent.pubkey);
    if (seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    candidates.push({
      pubkey,
      name: agent.name,
      source: "managed",
      online: agent.status === "running" || agent.status === "deployed",
      avatarUrl: agent.avatarUrl ?? null,
      status: agent.status,
      backend: agent.backend,
    });
  }

  for (const user of directoryUsers) {
    const pubkey = normalizePubkey(user.pubkey);
    if (!user.isAgent || managedPubkeys.has(pubkey) || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    candidates.push({
      pubkey,
      name:
        user.displayName?.trim() ||
        user.nip05Handle?.trim() ||
        truncatePubkey(pubkey),
      source: "connected",
      online: presence?.[pubkey] === "online",
      avatarUrl: user.avatarUrl ?? null,
    });
  }

  return candidates;
}

/**
 * Candidates for the huddle "Add Agent" dialog: running managed agents plus
 * connected (standalone) agents from the community directory. The huddle add
 * path (`add_agent_to_huddle`) publishes kind:9000 role=bot for an arbitrary
 * pubkey — no process management — so any verified community agent is
 * offerable, not just the ones this desktop spawns.
 */
export function useHuddleAgentCandidates() {
  const managedAgentsQuery = useManagedAgentsQuery();
  // Shared verified-agent enumeration; `mergeHuddleAgentCandidates` keeps
  // this surface's own filtering over the raw directory rows.
  const { directoryQuery, directoryUsers } = useVerifiedAgents();

  const managedAgents = React.useMemo(
    () => managedAgentsQuery.data ?? [],
    [managedAgentsQuery.data],
  );

  const connectedPubkeys = React.useMemo(
    () =>
      mergeHuddleAgentCandidates(managedAgents, directoryUsers)
        .filter((candidate) => candidate.source === "connected")
        .map((candidate) => candidate.pubkey),
    [directoryUsers, managedAgents],
  );
  const presenceQuery = usePresenceQuery(connectedPubkeys, {
    enabled: connectedPubkeys.length > 0,
  });

  const candidates = React.useMemo(
    () =>
      mergeHuddleAgentCandidates(
        managedAgents,
        directoryUsers,
        presenceQuery.data,
      ),
    [directoryUsers, managedAgents, presenceQuery.data],
  );

  return {
    candidates,
    /** Wait for both sources so the list doesn't pop in two stages. */
    isLoading: managedAgentsQuery.isLoading || directoryQuery.isLoading,
    /**
     * Only a total failure blocks the dialog; when a single source fails,
     * the other source's candidates still render.
     */
    isError: managedAgentsQuery.isError && directoryQuery.isError,
  };
}
