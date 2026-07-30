import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { useChannelFiles } from "@/features/files/hooks";
import type { FileIndexEntry } from "@/features/files/lib/fileIndex";
import { ChannelFilesList } from "@/features/files/ui/ChannelFilesList";
import type { Channel } from "@/shared/api/types";
import {
  AuxiliaryPanelBody,
  AuxiliaryPanelContext,
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
  getAuxiliaryPanelMode,
} from "@/shared/layout/AuxiliaryPanel";
import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  OverlayPanelBackdrop,
  PANEL_BASE_CLASS,
  PANEL_ENTER_MOTION_CLASS,
  PANEL_OVERLAY_CLASS,
} from "@/shared/ui/OverlayPanelBackdrop";

type ChannelFilesPanelProps = {
  animateSplitEnter?: boolean;
  channel: Channel | null;
  layout?: "overlay" | "split";
  onOpenChange: (open: boolean) => void;
  open: boolean;
  transparentChrome?: boolean;
};

/**
 * Channel Files panel — same right-hand slide-in as channel management
 * (`ChannelManagementSheet`): docked pane in split layout, overlay panel with
 * backdrop otherwise. Lists the relay-derived kind-1063 file index for the
 * channel, live-updating while open.
 */
export function ChannelFilesPanel({
  animateSplitEnter = false,
  channel,
  layout = "overlay",
  onOpenChange,
  open,
  transparentChrome = false,
}: ChannelFilesPanelProps) {
  const { isDark } = useTheme();
  const navigate = useNavigate();
  const isSplitLayout = layout === "split";
  const mode = getAuxiliaryPanelMode(isSplitLayout, !isSplitLayout);
  const channelId = channel?.id ?? null;
  const files = useChannelFiles(channelId, { enabled: open });

  const handleJumpToMessage = React.useCallback(
    (entry: FileIndexEntry) => {
      if (!channelId || !entry.messageId) return;
      onOpenChange(false);
      void navigate({
        to: "/channels/$channelId",
        params: { channelId },
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          messageId: entry.messageId ?? undefined,
        }),
      });
    },
    [channelId, navigate, onOpenChange],
  );

  const content = (
    <AuxiliaryPanelContext.Provider
      value={{
        isFloatingOverlay: mode === "panel",
        isOverlay: mode !== "docked",
        isSinglePanelView: mode === "single-panel",
        isSplitLayout: mode === "docked",
        layout: mode === "docked" ? "split" : "standalone",
        mode,
        onClose: () => onOpenChange(false),
        transparentChrome,
        widthPx: 380,
      }}
    >
      <AuxiliaryPanelHeader
        bordered={mode === "panel"}
        density={mode === "panel" ? "compact" : "comfortable"}
        mode={mode}
        transparent={transparentChrome}
      >
        <AuxiliaryPanelHeaderGroup mode={mode}>
          <DialogPrimitive.Title asChild>
            <AuxiliaryPanelTitle>Files</AuxiliaryPanelTitle>
          </DialogPrimitive.Title>
        </AuxiliaryPanelHeaderGroup>
        <DialogPrimitive.Description className="sr-only">
          Files shared in {channel ? `#${channel.name}` : "this channel"}
        </DialogPrimitive.Description>
      </AuxiliaryPanelHeader>

      <AuxiliaryPanelBody
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background px-4 pb-4"
        mode={mode}
        panelPadding
      >
        <div className="flex h-full min-h-0 flex-col pt-3">
          <ChannelFilesList
            entries={files.entries}
            hasError={files.hasError}
            isLoading={files.isLoading}
            onJumpToMessage={handleJumpToMessage}
          />
        </div>
      </AuxiliaryPanelBody>
    </AuxiliaryPanelContext.Provider>
  );

  return (
    <DialogPrimitive.Root
      modal={!isSplitLayout}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onOpenChange(false);
        }
      }}
      open={open}
    >
      {!isSplitLayout ? (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay asChild>
            <OverlayPanelBackdrop onClose={() => onOpenChange(false)} />
          </DialogPrimitive.Overlay>
        </DialogPrimitive.Portal>
      ) : null}
      {isSplitLayout ? (
        // Opaque surface, no backdrop blur — same stacking-context reasoning
        // as ChannelManagementSheet's split branch.
        <DialogPrimitive.Content
          className={cn(
            PANEL_BASE_CLASS,
            "h-full w-full cursor-default overflow-hidden border-l-0 p-0",
            animateSplitEnter && PANEL_ENTER_MOTION_CLASS,
          )}
          data-testid="channel-files-sheet"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          {content}
        </DialogPrimitive.Content>
      ) : (
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            className={cn(
              PANEL_BASE_CLASS,
              PANEL_OVERLAY_CLASS,
              PANEL_ENTER_MOTION_CLASS,
              "w-[380px] cursor-default overflow-hidden p-0 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-200",
              isDark
                ? "bg-background/85 backdrop-blur-xl supports-backdrop-filter:bg-background/75"
                : "bg-background",
            )}
            data-testid="channel-files-sheet"
          >
            {content}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
