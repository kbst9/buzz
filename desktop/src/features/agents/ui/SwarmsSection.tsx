import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import * as React from "react";

import {
  type SwarmDefinition,
  useSwarmsQuery,
} from "@/features/agents/lib/swarmDefinition";
import { swarmDisplayName } from "@/features/agents/lib/swarmDialogState";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { AgentIdentityCard } from "./AgentIdentityCard";
import { CreateIdentityCard } from "./CreateIdentityCard";
import { SwarmDialog, type SwarmDialogState } from "./SwarmDialog";
import { AGENT_CARD_GRID_CLASS } from "./UnifiedAgentsSection";

/**
 * Agents page › Swarms: the current user's owner-authored delegation groups
 * (kind:30978) — a named agent group with a required leader that attributes
 * mentioned tasks to exactly one member (docs/swarms.md §6). Rendered below
 * Teams with the same collapsible section-heading idiom as Connected agents;
 * cards show the swarm name (falling back to "{Leader}'s swarm"), the
 * leader's avatar, and the member count. The trailing plus-card opens the
 * create dialog, so the section renders with just that card when empty.
 */
export function SwarmsSection() {
  const identityQuery = useIdentityQuery();
  const me = identityQuery.data?.pubkey ?? null;
  const swarmsQuery = useSwarmsQuery(me ?? undefined);
  const swarms = React.useMemo(
    () => swarmsQuery.data ?? [],
    [swarmsQuery.data],
  );
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [dialog, setDialog] = React.useState<SwarmDialogState | null>(null);

  const leaderPubkeys = React.useMemo(
    () => [
      ...new Set(
        swarms
          .map((swarm) => normalizePubkey(swarm.leaderPubkey))
          .filter((pubkey) => pubkey !== ""),
      ),
    ],
    [swarms],
  );
  const leaderProfilesQuery = useUsersBatchQuery(leaderPubkeys, {
    enabled: leaderPubkeys.length > 0,
  });

  const leaderLabelFor = (swarm: SwarmDefinition): string => {
    const leader = normalizePubkey(swarm.leaderPubkey);
    if (leader === "") {
      return "No leader";
    }
    const profile = leaderProfilesQuery.data?.profiles?.[leader];
    return profile?.displayName?.trim() || truncatePubkey(leader);
  };

  return (
    <section className="w-full space-y-2" data-testid="agents-swarms-section">
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
        <span className="text-sm font-medium">Swarms</span>
        {swarms.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            ({swarms.length})
          </span>
        ) : null}
      </button>
      {!isCollapsed ? (
        <div className={AGENT_CARD_GRID_CLASS}>
          {swarms.map((swarm) => {
            const leaderLabel = leaderLabelFor(swarm);
            const displayName = swarmDisplayName(swarm.name, leaderLabel);
            const leader = normalizePubkey(swarm.leaderPubkey);
            const memberCount = swarm.members.length;
            return (
              <AgentIdentityCard
                actions={
                  <button
                    aria-label={`Edit ${displayName}`}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    data-testid={`swarm-edit-${swarm.id}`}
                    onClick={() => setDialog({ mode: "edit", swarm })}
                    type="button"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                }
                ariaLabel={`${displayName} swarm`}
                avatarUrl={
                  leader !== ""
                    ? (leaderProfilesQuery.data?.profiles?.[leader]
                        ?.avatarUrl ?? null)
                    : null
                }
                dataTestId={`swarm-card-${swarm.id}`}
                key={swarm.id}
                label={displayName}
                modelLabel={`${memberCount} member${memberCount === 1 ? "" : "s"}`}
                onClick={() => setDialog({ mode: "edit", swarm })}
              />
            );
          })}
          <CreateIdentityCard
            ariaLabel="Create swarm"
            dataTestId="create-swarm-card"
            label="Create swarm"
            onClick={() => setDialog({ mode: "create" })}
          />
        </div>
      ) : null}
      {dialog ? (
        <SwarmDialog
          key={dialog.mode === "edit" ? dialog.swarm.id : "create"}
          onOpenChange={(open) => {
            if (!open) {
              setDialog(null);
            }
          }}
          state={dialog}
        />
      ) : null}
    </section>
  );
}
