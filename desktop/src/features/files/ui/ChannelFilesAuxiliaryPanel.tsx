import type * as React from "react";

import { ChannelFilesPanel } from "@/features/files/ui/ChannelFilesPanel";
import { RightAuxiliaryPane } from "@/features/channels/ui/RightAuxiliaryPane";
import type { Channel } from "@/shared/api/types";

type ChannelFilesAuxiliaryPanelProps = {
  activeChannel: Channel;
  canResetThreadPanelWidth: boolean;
  isSinglePanelView: boolean;
  onCloseFilesPanel?: () => void;
  onResetThreadPanelWidth: () => void;
  onThreadPanelResizeStart: (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void;
  threadPanelWidthPx: number;
  useSplitAuxiliaryPane: boolean;
  transparentChrome?: boolean;
};

/**
 * Files entry in the channel pane's auxiliary slot — mirrors
 * `ChannelManagementAuxiliaryPanel`: docked `RightAuxiliaryPane` in split
 * layout, overlay slide-in otherwise.
 */
export function ChannelFilesAuxiliaryPanel({
  activeChannel,
  canResetThreadPanelWidth,
  isSinglePanelView,
  onCloseFilesPanel,
  onResetThreadPanelWidth,
  onThreadPanelResizeStart,
  threadPanelWidthPx,
  useSplitAuxiliaryPane,
  transparentChrome = false,
}: ChannelFilesAuxiliaryPanelProps) {
  const panel = (
    <ChannelFilesPanel
      animateSplitEnter={isSinglePanelView && !useSplitAuxiliaryPane}
      channel={activeChannel}
      layout={useSplitAuxiliaryPane || isSinglePanelView ? "split" : "overlay"}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCloseFilesPanel?.();
        }
      }}
      open={true}
      transparentChrome={transparentChrome}
    />
  );

  if (!useSplitAuxiliaryPane) {
    return panel;
  }

  return (
    <RightAuxiliaryPane
      canResetWidth={canResetThreadPanelWidth}
      onResetWidth={onResetThreadPanelWidth}
      onResizeStart={onThreadPanelResizeStart}
      testId="channel-files-auxiliary-pane"
      widthPx={threadPanelWidthPx}
    >
      {panel}
    </RightAuxiliaryPane>
  );
}
