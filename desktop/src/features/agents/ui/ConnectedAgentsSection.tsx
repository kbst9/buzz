import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import {
  selectConnectedAgents,
  synthesizeConnectedAgentRecord,
} from "@/features/agents/lib/connectedAgentRecords";
import { useChannelsQuery } from "@/features/channels/hooks";
import { usePresenceQuery } from "@/features/presence/hooks";
import {
  useFlattenedUserSearchResults,
  useInfiniteUserSearchQuery,
  useUsersBatchQuery,
} from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { PresenceLookup, UserSearchResult } from "@/shared/api/types";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { SectionHeader } from "@/shared/ui/PageHeader";
import { ManagedAgentRow } from "./ManagedAgentRow";

const EMPTY_PERSONA_LABELS: Record<string, string> = {};
const EMPTY_PRESENCE: PresenceLookup = {};

function noopSelectLogAgent() {
  // Connected agents run outside this app — there is no local log to open.
}

/**
 * Agents page › Connected agents: standalone agents in this community —
 * auth-tagged identities running their own harness somewhere, enumerated
 * from the user directory (`isAgent`) minus the managed list.
 *
 * Design requirement (CONNECTED_AGENT_PARITY.md §T4.1): connected agents
 * must look exactly like the other agents on this page — same row
 * component, same layout — with only a small Cable icon marking them as
 * connected. Rows therefore render through `ManagedAgentRow` on
 * synthesized `ManagedAgent`-shaped records; managed-only chrome already
 * self-gates on `backend.type === "local"`.
 */
export function ConnectedAgentsSection() {
  const { openProfilePanel } = useProfilePanel();
  const identityQuery = useIdentityQuery();
  const me = identityQuery.data?.pubkey ?? null;
  const managedAgentsQuery = useManagedAgentsQuery();
  const directoryQuery = useInfiniteUserSearchQuery("", {
    allowEmpty: true,
    limit: 50,
  });
  const directoryUsers = useFlattenedUserSearchResults(directoryQuery.data);
  const channelsQuery = useChannelsQuery();

  const managedPubkeys = React.useMemo(
    () =>
      new Set(
        (managedAgentsQuery.data ?? []).map((agent) =>
          normalizePubkey(agent.pubkey),
        ),
      ),
    [managedAgentsQuery.data],
  );

  const connectedAgents = React.useMemo(
    () => selectConnectedAgents(directoryUsers, managedPubkeys, me),
    [directoryUsers, managedPubkeys, me],
  );

  const rows = React.useMemo(
    () =>
      connectedAgents.map((user) => ({
        user,
        agent: synthesizeConnectedAgentRecord(user),
      })),
    [connectedAgents],
  );

  const agentPubkeys = React.useMemo(
    () => connectedAgents.map((agent) => agent.pubkey),
    [connectedAgents],
  );
  const presenceQuery = usePresenceQuery(agentPubkeys, {
    enabled: agentPubkeys.length > 0,
  });

  const ownerPubkeys = React.useMemo(
    () => [
      ...new Set(
        connectedAgents
          .map((agent) => agent.ownerPubkey)
          .filter((pubkey): pubkey is string => Boolean(pubkey)),
      ),
    ],
    [connectedAgents],
  );
  const ownerProfilesQuery = useUsersBatchQuery(ownerPubkeys, {
    enabled: ownerPubkeys.length > 0,
  });

  const channelIdToName = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const channel of channelsQuery.data ?? []) {
      map[channel.id] = channel.name;
    }
    return map;
  }, [channelsQuery.data]);

  const channelsByPubkey = React.useMemo(() => {
    const connectedPubkeys = new Set(
      connectedAgents.map((agent) => normalizePubkey(agent.pubkey)),
    );
    const map: Record<string, { id: string; name: string }[]> = {};
    for (const channel of channelsQuery.data ?? []) {
      for (const memberPubkey of channel.memberPubkeys) {
        const key = normalizePubkey(memberPubkey);
        if (!connectedPubkeys.has(key)) continue;
        if (!map[key]) map[key] = [];
        if (!map[key].some((entry) => entry.id === channel.id)) {
          map[key].push({ id: channel.id, name: channel.name });
        }
      }
    }
    return map;
  }, [channelsQuery.data, connectedAgents]);

  // Owner attribution for agents the viewer does not own (the viewer's own
  // agents need no line). ManagedAgentRow has no owner slot, so the line
  // renders in the section's row wrapper rather than restructuring the row.
  const ownerLineFor = (user: UserSearchResult): string | null => {
    if (!user.ownerPubkey) {
      return null;
    }
    const owner = normalizePubkey(user.ownerPubkey);
    if (me && owner === normalizePubkey(me)) {
      return null;
    }
    const profile = ownerProfilesQuery.data?.profiles?.[owner];
    return `Owned by ${
      profile?.displayName?.trim() || truncatePubkey(user.ownerPubkey)
    }`;
  };

  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4" data-testid="agents-connected-section">
      <SectionHeader
        description="Agents that live outside this app — standalone harnesses and other members' agents."
        title="Connected agents"
      />
      <div className="divide-y divide-border/50 border-t border-border/50">
        {rows.map(({ user, agent }) => {
          const ownerLine = ownerLineFor(user);
          return (
            <div
              data-testid={`connected-agent-row-${agent.pubkey}`}
              key={agent.pubkey}
            >
              <ManagedAgentRow
                agent={agent}
                channelIdToName={channelIdToName}
                channelNames={
                  channelsByPubkey[normalizePubkey(agent.pubkey)] ?? []
                }
                connected
                isLogSelected={false}
                logContent={null}
                logError={null}
                logLoading={false}
                personaLabelsById={EMPTY_PERSONA_LABELS}
                presenceLoaded={presenceQuery.isSuccess}
                presenceLookup={presenceQuery.data ?? EMPTY_PRESENCE}
                onOpenProfile={(pubkey) => {
                  openProfilePanel?.(pubkey);
                }}
                onSelectLogAgent={noopSelectLogAgent}
              />
              {ownerLine ? (
                <p className="-mt-2 pb-3 pl-16 pr-4 text-xs text-muted-foreground">
                  {ownerLine}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
