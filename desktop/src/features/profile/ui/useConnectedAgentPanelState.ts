import * as React from "react";

import { useConnectedAgentDefinitionQuery } from "@/features/agents/lib/connectedAgentDefinition";
import type { Profile, UserSearchResult } from "@/shared/api/types";

/**
 * Panel-side glue for an owned CONNECTED agent (standalone harness — no
 * local record, no persona). Extracted from UserProfilePanel for the size
 * guard. Such agents are editable through the owner-signed relay paths
 * (kind:30177 definition + live set_profile control frame), so no key
 * custody is required:
 *
 * - `canEditConnectedAgent` gates the Edit affordance and the definition
 *   fetch (owner-side only; shares the edit dialog's query cache).
 * - `connectedEditAgent` is the UserSearchResult-shaped dialog value, built
 *   from data the panel already holds (the dialog contract mirrors the
 *   settings card's directory rows).
 * - `connectedAgentInstructions` is the owner-authored kind:30177 text.
 */
export function useConnectedAgentPanelState({
  effectivePubkey,
  hasLocalAgentRecord,
  isBot,
  ownerPubkey,
  profile,
  viewerIsOwner,
}: {
  effectivePubkey: string | null;
  /** True when a managed-agent record or persona backs this profile. */
  hasLocalAgentRecord: boolean;
  isBot: boolean;
  ownerPubkey: string | null;
  profile: Profile | null | undefined;
  viewerIsOwner: boolean;
}) {
  const canEditConnectedAgent =
    viewerIsOwner && isBot && !hasLocalAgentRecord && effectivePubkey !== null;
  const connectedAgentDefinitionQuery = useConnectedAgentDefinitionQuery(
    canEditConnectedAgent ? (ownerPubkey ?? undefined) : undefined,
    effectivePubkey ?? undefined,
  );

  const connectedEditAgent = React.useMemo<UserSearchResult | null>(
    () =>
      effectivePubkey
        ? {
            pubkey: effectivePubkey,
            displayName: profile?.displayName ?? null,
            avatarUrl: profile?.avatarUrl ?? null,
            nip05Handle: profile?.nip05Handle ?? null,
            ownerPubkey,
            isAgent: true,
          }
        : null,
    [
      effectivePubkey,
      ownerPubkey,
      profile?.avatarUrl,
      profile?.displayName,
      profile?.nip05Handle,
    ],
  );

  return {
    canEditConnectedAgent,
    connectedAgentInstructions:
      connectedAgentDefinitionQuery.data?.instructions ?? null,
    connectedEditAgent,
  };
}
