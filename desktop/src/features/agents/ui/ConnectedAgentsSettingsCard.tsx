import { Cable, Pencil, Plus } from "lucide-react";
import * as React from "react";

import { buildAddAgentInstructions } from "@/features/agents/lib/connectedAgentInstructions";
import { useVerifiedAgents } from "@/features/agents/lib/useVerifiedAgents";
import {
  ConnectedAgentEditDialog,
  CopyableInstructions,
} from "@/features/agents/ui/ConnectedAgentEditDialog";
import { usePresenceQuery } from "@/features/presence/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { UserSearchResult } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { UserAvatar } from "@/shared/ui/UserAvatar";

/**
 * Settings › Connected agents: standalone agents in this community —
 * auth-tagged identities running their own harness somewhere, not managed
 * by this desktop. The desktop never holds their keys, so "Add" and "Edit"
 * generate exact, copy-pastable instructions for the host operator (human
 * or AI) instead of acting directly. See docs/standalone-agents.md.
 */
export function ConnectedAgentsSettingsCard({
  currentPubkey,
  relayUrl,
}: {
  currentPubkey?: string;
  relayUrl?: string;
}) {
  const identityQuery = useIdentityQuery();
  const me = currentPubkey ?? identityQuery.data?.pubkey;
  // Shared verified-agent enumeration; managed identities stay under the
  // Agents tab instead of being re-offered as connected here.
  const { agents: verifiedAgents, directoryQuery } = useVerifiedAgents({
    excludeManaged: true,
  });

  const connectedAgents = React.useMemo(() => {
    const mine = me ? normalizePubkey(me) : null;
    return [...verifiedAgents].sort((left, right) => {
      const leftMine =
        mine && left.ownerPubkey && normalizePubkey(left.ownerPubkey) === mine;
      const rightMine =
        mine &&
        right.ownerPubkey &&
        normalizePubkey(right.ownerPubkey) === mine;
      if (leftMine !== rightMine) {
        return leftMine ? -1 : 1;
      }
      return agentLabel(left).localeCompare(agentLabel(right));
    });
  }, [me, verifiedAgents]);

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

  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserSearchResult | null>(null);

  const ownerLabelFor = (agent: UserSearchResult) => {
    if (!agent.ownerPubkey) {
      return null;
    }
    if (me && normalizePubkey(agent.ownerPubkey) === normalizePubkey(me)) {
      return "Owned by you";
    }
    const profile =
      ownerProfilesQuery.data?.profiles?.[normalizePubkey(agent.ownerPubkey)];
    return `Owned by ${
      profile?.displayName?.trim() || truncatePubkey(agent.ownerPubkey)
    }`;
  };

  return (
    <div className="space-y-4" data-testid="connected-agents-settings">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Cable className="h-5 w-5" aria-hidden="true" />
            Connected agents
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents that live outside this app — standalone harnesses and other
            members' agents. This app never holds their keys: online agents you
            own apply profile edits themselves over the relay, and everything
            else comes as exact instructions for the machine that holds them.
          </p>
        </div>
        <Button
          data-testid="connected-agents-add"
          onClick={() => setAddOpen(true)}
          size="sm"
        >
          <Plus className="h-4 w-4" />
          Add agent
        </Button>
      </div>

      {connectedAgents.length === 0 ? (
        <p className="rounded-2xl border border-border/60 px-4 py-6 text-sm text-muted-foreground">
          {directoryQuery.isLoading
            ? "Looking for agents in this community…"
            : "No standalone agents found in this community yet. Add one to get started."}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {connectedAgents.map((agent) => {
            const presence =
              presenceQuery.data?.[normalizePubkey(agent.pubkey)] ?? null;
            const online = presence === "online";
            const owned = Boolean(
              me &&
                agent.ownerPubkey &&
                normalizePubkey(agent.ownerPubkey) === normalizePubkey(me),
            );
            return (
              <li
                className="flex items-start gap-3 rounded-2xl border border-border/60 bg-background px-4 py-3"
                data-testid={`connected-agent-${agent.pubkey}`}
                key={agent.pubkey}
              >
                <UserAvatar
                  avatarUrl={agent.avatarUrl ?? null}
                  className="h-10 w-10 shrink-0"
                  displayName={agentLabel(agent)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {agentLabel(agent)}
                    </span>
                    <span
                      aria-label={online ? "online" : "offline"}
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        online ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                      role="img"
                    />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {ownerLabelFor(agent) ?? truncatePubkey(agent.pubkey)}
                  </p>
                </div>
                {owned ? (
                  <Button
                    data-testid={`connected-agent-edit-${agent.pubkey}`}
                    onClick={() => setEditing(agent)}
                    size="sm"
                    variant="outline"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit profile
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {directoryQuery.hasNextPage ? (
        <Button
          disabled={directoryQuery.isFetchingNextPage}
          onClick={() => void directoryQuery.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {directoryQuery.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}

      <AddAgentDialog
        onOpenChange={setAddOpen}
        open={addOpen}
        ownerPubkey={me ?? ""}
        relayUrl={relayUrl ?? ""}
      />
      <ConnectedAgentEditDialog
        agent={editing}
        online={
          editing
            ? presenceQuery.data?.[normalizePubkey(editing.pubkey)] === "online"
            : false
        }
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}

function agentLabel(agent: UserSearchResult) {
  return (
    agent.displayName?.trim() ||
    agent.nip05Handle?.trim() ||
    truncatePubkey(agent.pubkey)
  );
}

function AddAgentDialog({
  open,
  onOpenChange,
  relayUrl,
  ownerPubkey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  relayUrl: string;
  ownerPubkey: string;
}) {
  const instructions = React.useMemo(
    () => buildAddAgentInstructions({ ownerPubkey, relayUrl }),
    [ownerPubkey, relayUrl],
  );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a connected agent</DialogTitle>
          <DialogDescription>
            Paste this to an AI (or a person) with shell access on the machine
            that will run the agent. Your relay URL and owner pubkey are filled
            in; the owner secret is never part of it.
          </DialogDescription>
        </DialogHeader>
        <CopyableInstructions
          testId="connected-agents-add-instructions"
          text={instructions}
        />
      </DialogContent>
    </Dialog>
  );
}
