import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { useChannelFiles } from "@/features/files/hooks";
import type { FileIndexEntry } from "@/features/files/lib/fileIndex";
import { ChannelFilesList } from "@/features/files/ui/ChannelFilesList";
import type { Channel } from "@/shared/api/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";

/**
 * Per-channel Files drawer — the standard right-hand sheet, opened from the
 * `channel-files-trigger` button in the channel header. Lists the
 * relay-derived kind-1063 index for the active channel, live-updating while
 * open (the hook is disabled when closed; reopening refetches).
 */
export function ChannelFilesSheet({
  channel,
  onOpenChange,
  open,
}: {
  channel: Channel | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const navigate = useNavigate();
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

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="flex w-[400px] flex-col gap-4 sm:max-w-[420px]"
        data-testid="channel-files-sheet"
        side="right"
      >
        <SheetHeader className="shrink-0 text-left">
          <SheetTitle>Files</SheetTitle>
          <SheetDescription>
            Files shared in {channel ? `#${channel.name}` : "this channel"}.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">
          <ChannelFilesList
            entries={files.entries}
            hasError={files.hasError}
            isLoading={files.isLoading}
            onJumpToMessage={handleJumpToMessage}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
