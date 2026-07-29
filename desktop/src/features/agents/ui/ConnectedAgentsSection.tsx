import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import {
  selectConnectedAgents,
  synthesizeConnectedAgentRecord,
} from "@/features/agents/lib/connectedAgentRecords";
import { usePresenceQuery } from "@/features/presence/hooks";
import {
  useFlattenedUserSearchResults,
  useInfiniteUserSearchQuery,
  useUsersBatchQuery,
} from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ManagedAgent, UserSearchResult } from "@/shared/api/types";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { AgentIdentityCard } from "./AgentIdentityCard";
import { AgentRuntimeAvatarControl } from "./AgentRuntimeAvatarControl";
import { CreateIdentityCard } from "./CreateIdentityCard";
import { AGENT_CARD_GRID_CLASS } from "./UnifiedAgentsSection";

function noopStart() {
  // Connected agents run outside this app — there is nothing to start here.
  // Never reachable: the runtime avatar control is only rendered while the
  // agent is online, and the active branch has no start affordance.
}

/**
 * Agents page › Connected agents: standalone agents in this community —
 * auth-tagged identities running their own harness somewhere, enumerated
 * from the user directory (`isAgent`) minus the managed list.
 *
 * Design requirement (CONNECTED_AGENT_PARITY.md §T4.1): connected agents
 * must look exactly like the other agents on this page — same card
 * component, same layout — with only a small Cable icon marking them as
 * connected. Cards therefore render through `AgentIdentityCard` on the
 * exact grid the managed identities use, feeding synthesized
 * `ManagedAgent`-shaped records; managed-only chrome (the start control)
 * is simply not rendered, mirroring how the card idiom self-gates.
 */
export function ConnectedAgentsSection() {
  const { openProfilePanel } = useProfilePanel();
  const { goSettings } = useAppNavigation();
  const identityQuery = useIdentityQuery();
  const me = identityQuery.data?.pubkey ?? null;
  const managedAgentsQuery = useManagedAgentsQuery();
  const directoryQuery = useInfiniteUserSearchQuery("", {
    allowEmpty: true,
    limit: 50,
  });
  const directoryUsers = useFlattenedUserSearchResults(directoryQuery.data);
  const [isCollapsed, setIsCollapsed] = React.useState(false);

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

  const cards = React.useMemo(
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

  // Owner attribution for agents the viewer does not own (the viewer's own
  // agents need no line). Rendered in the card's secondary-line slot.
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

  return (
    <section
      className="w-full space-y-2"
      data-testid="agents-connected-section"
    >
      <button
        className="group flex items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/50"
        onClick={() => setIsCollapsed((current) => !current)}
        type="button"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">Connected agents</span>
        {cards.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            ({cards.length})
          </span>
        ) : null}
      </button>
      {!isCollapsed ? (
        <div className={AGENT_CARD_GRID_CLASS}>
          {cards.map(({ user, agent }) => (
            <ConnectedAgentCard
              agent={agent}
              key={agent.pubkey}
              online={
                presenceQuery.data?.[normalizePubkey(agent.pubkey)] === "online"
              }
              ownerLabel={ownerLineFor(user)}
              onOpenProfile={(pubkey) => {
                openProfilePanel?.(pubkey);
              }}
            />
          ))}
          {/* Adding a connected agent means standing up a harness elsewhere —
              the settings card owns that flow (host instructions). */}
          <CreateIdentityCard
            ariaLabel="Add connected agent"
            dataTestId="add-connected-agent-card"
            onClick={() => void goSettings("connected-agents")}
          />
        </div>
      ) : null}
    </section>
  );
}

function ConnectedAgentCard({
  agent,
  online,
  ownerLabel,
  onOpenProfile,
}: {
  agent: ManagedAgent;
  online: boolean;
  ownerLabel: string | null;
  onOpenProfile: (pubkey: string) => void;
}) {
  const title = agent.name;

  return (
    <AgentIdentityCard
      ariaLabel={`${title} agent profile`}
      avatar={
        // Online connected agents get the same active-dot avatar frame as a
        // running managed agent. Offline ones fall back to the card's plain
        // avatar rather than the managed start affordance — this app cannot
        // start an agent it does not host.
        online ? (
          <AgentRuntimeAvatarControl
            activeTestId={`agent-runtime-active-${agent.pubkey}`}
            avatarUrl={agent.avatarUrl}
            isActive
            isStarting={false}
            label={title}
            startTestId={`agent-runtime-start-${agent.pubkey}`}
            onStart={noopStart}
          />
        ) : undefined
      }
      avatarUrl={agent.avatarUrl}
      connected
      dataTestId={`connected-agent-${agent.pubkey}`}
      label={title}
      modelLabel={ownerLabel}
      onClick={() => {
        onOpenProfile(agent.pubkey);
      }}
    />
  );
}
