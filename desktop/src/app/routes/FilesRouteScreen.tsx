import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { useChannelsQuery } from "@/features/channels/hooks";
import { CommunityFilesScreen } from "@/features/files/ui/CommunityFilesScreen";

export function FilesRouteScreen() {
  const navigate = useNavigate();
  const channelsQuery = useChannelsQuery();
  const channels = channelsQuery.data ?? [];

  const handleJumpToMessage = React.useCallback(
    (channelId: string, messageId: string) => {
      void navigate({
        to: "/channels/$channelId",
        params: { channelId },
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          messageId,
        }),
      });
    },
    [navigate],
  );

  return (
    <CommunityFilesScreen
      channels={channels}
      onJumpToMessage={handleJumpToMessage}
    />
  );
}
