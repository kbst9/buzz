import { ChevronDown, ChevronRight, FolderOpen, Hash } from "lucide-react";
import * as React from "react";

import { useChannelFiles } from "@/features/files/hooks";
import { ChannelFilesList } from "@/features/files/ui/ChannelFilesList";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";

/**
 * Community-wide file explorer: one accordion per member channel.
 *
 * Expanding a section is what mounts that channel's `useChannelFiles` query —
 * the lazy-load IS the privacy model: only membership-scoped, per-channel
 * queries ever fire, and an unscoped kinds-only query has no code path
 * (docs/channel-files-explorer.md § Privacy). DM channels are absent because
 * DMs are unindexed by design.
 */
export function CommunityFilesScreen({
  channels,
  onJumpToMessage,
}: {
  channels: Channel[];
  onJumpToMessage: (channelId: string, messageId: string) => void;
}) {
  const eligible = React.useMemo(
    () =>
      channels.filter(
        (channel) =>
          channel.isMember &&
          channel.channelType !== "dm" &&
          !channel.archivedAt,
      ),
    [channels],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-center gap-2">
          <FolderOpen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Files</h1>
        </div>
        {eligible.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Join a channel to see its shared files here.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="community-files-channels">
            {eligible.map((channel) => (
              <ChannelFilesAccordion
                channel={channel}
                key={channel.id}
                onJumpToMessage={onJumpToMessage}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChannelFilesAccordion({
  channel,
  onJumpToMessage,
}: {
  channel: Channel;
  onJumpToMessage: (channelId: string, messageId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  return (
    <li className="rounded-xl border border-border/60">
      <button
        aria-expanded={isExpanded}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left",
          "hover:bg-muted/40",
          isExpanded && "rounded-b-none border-b border-border/60",
        )}
        data-testid={`community-files-channel-${channel.name}`}
        onClick={() => setIsExpanded((prev) => !prev)}
        type="button"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{channel.name}</span>
      </button>
      {/* The body (and its channel-scoped query) exists only once expanded. */}
      {isExpanded ? (
        <div className="max-h-[420px] px-4 pb-4 pt-3">
          <ChannelFilesAccordionBody
            channel={channel}
            onJumpToMessage={onJumpToMessage}
          />
        </div>
      ) : null}
    </li>
  );
}

function ChannelFilesAccordionBody({
  channel,
  onJumpToMessage,
}: {
  channel: Channel;
  onJumpToMessage: (channelId: string, messageId: string) => void;
}) {
  const files = useChannelFiles(channel.id);
  return (
    <ChannelFilesList
      emptyLabel="No files shared in this channel yet."
      entries={files.entries}
      hasError={files.hasError}
      isLoading={files.isLoading}
      onJumpToMessage={(entry) => {
        if (entry.messageId) {
          onJumpToMessage(channel.id, entry.messageId);
        }
      }}
    />
  );
}
