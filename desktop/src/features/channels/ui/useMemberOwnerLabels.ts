import * as React from "react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ChannelMember } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Profile lookup for the "managed by {owner}" attribution line on agent
 * member rows (extracted from MembersSidebar for the size guard; mirrors
 * `addSearchOwnerPubkeys` for add-candidate rows).
 *
 * Owners of agent members are batch-fetched with the viewer excluded —
 * `formatOwnerLabel` renders the viewer as "you" without a profile lookup.
 * The returned lookup merges both sources: member profiles cover owners who
 * are themselves in the channel (no extra roundtrip), the dedicated batch
 * covers owners who are not members.
 */
export function useMemberOwnerProfileLookup({
  currentPubkey,
  memberProfiles,
  open,
  rawMembers,
}: {
  currentPubkey?: string | null;
  memberProfiles: UserProfileLookup | undefined;
  open: boolean;
  rawMembers: readonly Pick<ChannelMember, "pubkey">[];
}): UserProfileLookup {
  const memberOwnerPubkeys = React.useMemo(() => {
    const profiles = memberProfiles ?? {};
    const viewerPubkey = currentPubkey ? normalizePubkey(currentPubkey) : null;
    return [
      ...new Set(
        rawMembers.flatMap((member) => {
          const ownerPubkey =
            profiles[normalizePubkey(member.pubkey)]?.ownerPubkey;
          if (!ownerPubkey) {
            return [];
          }

          const normalized = normalizePubkey(ownerPubkey);
          return normalized === viewerPubkey ? [] : [normalized];
        }),
      ),
    ];
  }, [currentPubkey, memberProfiles, rawMembers]);
  const memberOwnerProfilesQuery = useUsersBatchQuery(memberOwnerPubkeys, {
    enabled: open && memberOwnerPubkeys.length > 0,
  });

  return React.useMemo(
    () => ({
      ...memberProfiles,
      ...memberOwnerProfilesQuery.data?.profiles,
    }),
    [memberProfiles, memberOwnerProfilesQuery.data?.profiles],
  );
}
