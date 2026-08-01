import * as React from "react";
import {
  resolveTimelineLoadingLatch,
  selectTimelineLoadingState,
} from "@/features/messages/lib/timelineLoadingState";
import type { Channel } from "@/shared/api/types";

/**
 * Latched timeline loading state for the active channel: loading resolves
 * once per channel and stays settled through background refetches, so the
 * skeleton cannot flash on window refocus. Forum channels render their own
 * content and never report timeline loading.
 */
export function useTimelineLoadingLatch({
  activeChannel,
  activeChannelId,
  query,
}: {
  activeChannel: Channel | null;
  activeChannelId: string | null;
  query: {
    isPending: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
    data?: readonly unknown[] | null;
  };
}): boolean {
  const settledChannelIdRef = React.useRef<string | null>(null);
  const hasSettledThisChannel =
    activeChannelId !== null && settledChannelIdRef.current === activeChannelId;
  const timelineLoadingNow =
    activeChannel !== null &&
    activeChannel.channelType !== "forum" &&
    selectTimelineLoadingState(
      {
        isPending: query.isPending,
        isFetching: query.isFetching,
        isPlaceholderData: query.isPlaceholderData,
        dataLength: query.data?.length ?? null,
      },
      hasSettledThisChannel,
    );
  const { settledChannelId, isLoading } = resolveTimelineLoadingLatch(
    settledChannelIdRef.current,
    activeChannelId,
    timelineLoadingNow,
  );
  settledChannelIdRef.current = settledChannelId;
  return isLoading;
}
