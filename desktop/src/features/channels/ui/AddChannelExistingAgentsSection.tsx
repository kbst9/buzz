import { Check } from "lucide-react";
import * as React from "react";

import { useVerifiedAgents } from "@/features/agents/lib/useVerifiedAgents";
import {
  useAddChannelMembersMutation,
  useChannelMembersQuery,
} from "@/features/channels/hooks";
import {
  formatExistingAgentLabel,
  selectAddChannelExistingAgentCandidates,
} from "@/features/channels/ui/addChannelExistingAgentCandidates";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { UserSearchResult } from "@/shared/api/types";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

type AddChannelExistingAgentsSectionProps = {
  channelId: string | null;
  enabled: boolean;
};

/**
 * "Existing agents" section of the channel "Add agents" dialog: connected
 * agents already living in this community (standalone, auth-tagged members
 * running their own harness) that are not yet members of the target channel.
 *
 * Adding one publishes the same plain relay member-add (kind:9000, role
 * "bot") the members-sidebar picker uses — the relay's `channel_add_policy`
 * authorizes or refuses, and refusals surface as per-row errors. No local
 * provisioning happens here; that is what distinguishes this section from
 * the persona/team sections above it.
 */
export function AddChannelExistingAgentsSection({
  channelId,
  enabled,
}: AddChannelExistingAgentsSectionProps) {
  const identityQuery = useIdentityQuery();
  const viewerPubkey = identityQuery.data?.pubkey ?? null;
  // Shared verified-agent enumeration; the candidates helper below keeps
  // this dialog's own membership/exclusion filtering and sorting.
  const { directoryUsers, managedPubkeys } = useVerifiedAgents({ enabled });
  const membersQuery = useChannelMembersQuery(channelId, enabled);
  const addMembersMutation = useAddChannelMembersMutation(channelId);

  const [pendingPubkeys, setPendingPubkeys] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const [addedPubkeys, setAddedPubkeys] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errorByPubkey, setErrorByPubkey] = React.useState<
    ReadonlyMap<string, string>
  >(() => new Map());

  // Keep just-added agents visible (with an "Added" check) instead of
  // letting the membership refetch silently drop their rows mid-dialog.
  const memberPubkeys = React.useMemo(
    () =>
      (membersQuery.data ?? [])
        .map((member) => normalizePubkey(member.pubkey))
        .filter((pubkey) => !addedPubkeys.has(pubkey)),
    [addedPubkeys, membersQuery.data],
  );
  const candidates = React.useMemo(
    () =>
      selectAddChannelExistingAgentCandidates({
        excludedPubkeys: managedPubkeys,
        memberPubkeys,
        users: directoryUsers,
        viewerPubkey,
      }),
    [directoryUsers, managedPubkeys, memberPubkeys, viewerPubkey],
  );

  const ownerPubkeys = React.useMemo(
    () => [
      ...new Set(
        candidates
          .map((agent) => agent.ownerPubkey)
          .filter((pubkey): pubkey is string =>
            Boolean(
              pubkey &&
                (!viewerPubkey ||
                  normalizePubkey(pubkey) !== normalizePubkey(viewerPubkey)),
            ),
          ),
      ),
    ],
    [candidates, viewerPubkey],
  );
  const ownerProfilesQuery = useUsersBatchQuery(ownerPubkeys, {
    enabled: enabled && ownerPubkeys.length > 0,
  });

  const ownerLabelFor = (agent: UserSearchResult) => {
    if (!agent.ownerPubkey) {
      return null;
    }
    if (
      viewerPubkey &&
      normalizePubkey(agent.ownerPubkey) === normalizePubkey(viewerPubkey)
    ) {
      return "Owned by you";
    }
    const profile =
      ownerProfilesQuery.data?.profiles?.[normalizePubkey(agent.ownerPubkey)];
    return `Owned by ${
      profile?.displayName?.trim() || truncatePubkey(agent.ownerPubkey)
    }`;
  };

  async function handleAdd(agent: UserSearchResult) {
    const pubkey = normalizePubkey(agent.pubkey);
    if (pendingPubkeys.has(pubkey) || addedPubkeys.has(pubkey)) {
      return;
    }

    setPendingPubkeys((prev) => new Set(prev).add(pubkey));
    setErrorByPubkey((prev) => {
      const next = new Map(prev);
      next.delete(pubkey);
      return next;
    });

    try {
      // The plain relay member-add the members-sidebar picker uses. The
      // relay's channel_add_policy decides whether this caller may add the
      // agent; refusals come back as per-pubkey errors below.
      const result = await addMembersMutation.mutateAsync({
        pubkeys: [agent.pubkey],
        role: "bot",
      });
      const failure = result.errors.find(
        (entry) => normalizePubkey(entry.pubkey) === pubkey,
      );
      if (failure) {
        setErrorByPubkey((prev) => new Map(prev).set(pubkey, failure.error));
        return;
      }
      setAddedPubkeys((prev) => new Set(prev).add(pubkey));
    } catch (error) {
      setErrorByPubkey((prev) =>
        new Map(prev).set(
          pubkey,
          error instanceof Error ? error.message : "Failed to add agent.",
        ),
      );
    } finally {
      setPendingPubkeys((prev) => {
        const next = new Set(prev);
        next.delete(pubkey);
        return next;
      });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  return (
    <div
      className="space-y-3"
      data-testid="add-channel-existing-agents-section"
    >
      <div>
        <div className="text-sm font-medium">Existing agents</div>
        <p className="text-xs text-muted-foreground">
          Already in this community — added to the channel directly, no new
          agent is created.
        </p>
      </div>

      <div className="space-y-1">
        {candidates.map((agent) => {
          const pubkey = normalizePubkey(agent.pubkey);
          const label = formatExistingAgentLabel(agent);
          const isPending = pendingPubkeys.has(pubkey);
          const isAdded = addedPubkeys.has(pubkey);
          const errorMessage = errorByPubkey.get(pubkey) ?? null;
          return (
            <div
              className="rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/60"
              data-testid={`add-channel-existing-agent-${agent.pubkey}`}
              key={agent.pubkey}
            >
              <div className="flex w-full items-center gap-3">
                <UserAvatar
                  avatarUrl={agent.avatarUrl ?? null}
                  displayName={label}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {ownerLabelFor(agent) ?? truncatePubkey(agent.pubkey)}
                  </span>
                </span>
                {isAdded ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Check className="h-4 w-4" />
                    Added
                  </span>
                ) : (
                  <Button
                    data-testid={`add-channel-existing-agent-add-${agent.pubkey}`}
                    disabled={isPending}
                    onClick={() => void handleAdd(agent)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {isPending ? "Adding…" : "Add"}
                  </Button>
                )}
              </div>
              {errorMessage ? (
                <p className="mt-1 pl-12 text-xs text-destructive">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
