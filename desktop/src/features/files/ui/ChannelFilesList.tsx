import {
  Download,
  File as FileIcon,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
} from "lucide-react";
import * as React from "react";

import { toast } from "sonner";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { invokeTauri } from "@/shared/api/tauri";
import {
  type FileIndexEntry,
  type FileTypeClass,
  formatFileSize,
} from "@/features/files/lib/fileIndex";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

type TypeFilter = "all" | FileTypeClass;

const FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "image", label: "Images" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "doc", label: "Docs" },
];

function TypeGlyph({ typeClass }: { typeClass: FileTypeClass }) {
  const className = "h-4 w-4 text-muted-foreground";
  switch (typeClass) {
    case "image":
      return <ImageIcon className={className} />;
    case "video":
      return <Film className={className} />;
    case "audio":
      return <Music className={className} />;
    default:
      return <FileText className={className} />;
  }
}

function shareDateLabel(sharedAt: number): string {
  const date = new Date(sharedAt * 1000);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/**
 * Filterable file-index list shared by the channel Files drawer and the
 * community Files screen. Entries come from `useChannelFiles`.
 */
export function ChannelFilesList({
  emptyLabel = "No files shared in this channel yet.",
  entries,
  hasError,
  isLoading,
  onJumpToMessage,
}: {
  emptyLabel?: string;
  entries: FileIndexEntry[];
  hasError: boolean;
  isLoading: boolean;
  onJumpToMessage?: (entry: FileIndexEntry) => void;
}) {
  const [filter, setFilter] = React.useState<TypeFilter>("all");
  const uploaderPubkeys = React.useMemo(
    () =>
      [...new Set(entries.map((entry) => entry.uploader))].filter(
        (pubkey): pubkey is string => Boolean(pubkey),
      ),
    [entries],
  );
  const profilesQuery = useUsersBatchQuery(uploaderPubkeys, {
    enabled: uploaderPubkeys.length > 0,
  });
  const profiles = profilesQuery.data?.profiles ?? {};

  const visible =
    filter === "all"
      ? entries
      : entries.filter((entry) => entry.typeClass === filter);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        className="flex shrink-0 flex-wrap gap-1"
        data-testid="files-type-filters"
      >
        {FILTERS.map(({ key, label }) => (
          <Button
            className={cn(
              "h-7 rounded-full px-3 text-xs",
              filter === key && "pointer-events-none",
            )}
            data-testid={`files-filter-${key}`}
            key={key}
            onClick={() => setFilter(key)}
            size="sm"
            type="button"
            variant={filter === key ? "default" : "outline"}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="files-list">
        {isLoading && entries.length === 0 ? (
          <div className="space-y-2 py-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div
                className="h-12 animate-pulse rounded-lg bg-muted/40"
                key={i}
              />
            ))}
          </div>
        ) : hasError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Couldn&apos;t load files for this channel.
          </p>
        ) : visible.length === 0 ? (
          <p
            className="py-6 text-center text-sm text-muted-foreground"
            data-testid="files-empty"
          >
            {filter === "all" ? emptyLabel : "No files of this type."}
          </p>
        ) : (
          <ul className="space-y-1">
            {visible.map((entry) => {
              const profile = entry.uploader
                ? profiles[entry.uploader]
                : undefined;
              const uploaderName =
                profile?.displayName ??
                (entry.uploader ? truncatePubkey(entry.uploader) : null);
              const thumbUrl =
                entry.typeClass === "image"
                  ? rewriteRelayUrl(entry.thumb ?? entry.url)
                  : entry.thumb
                    ? rewriteRelayUrl(entry.thumb)
                    : null;
              const jump =
                onJumpToMessage && entry.messageId
                  ? () => onJumpToMessage(entry)
                  : undefined;
              const rowBody = (
                <>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/30">
                    {thumbUrl ? (
                      <img
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                        src={thumbUrl}
                      />
                    ) : (
                      <TypeGlyph typeClass={entry.typeClass} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-sm font-medium"
                      title={entry.name}
                    >
                      {entry.name}
                    </p>
                    <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <span>{shareDateLabel(entry.sharedAt)}</span>
                      {entry.sizeBytes !== null && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{formatFileSize(entry.sizeBytes)}</span>
                        </>
                      )}
                      {uploaderName && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1 truncate">
                            <UserAvatar
                              avatarUrl={profile?.avatarUrl ?? null}
                              displayName={uploaderName}
                              size="xs"
                            />
                            <span className="truncate">{uploaderName}</span>
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  {/* Native download_file command (tunnel HTTP + save
                      dialog) — a plain <a download> is ignored by the
                      webview; see shared/ui/markdown/FileCard.tsx. */}
                  <button
                    aria-label={`Download ${entry.name}`}
                    className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    data-testid="files-download"
                    onClick={(event) => {
                      event.stopPropagation();
                      invokeTauri("download_file", {
                        url: entry.url,
                        filename: entry.name,
                      }).catch((err: unknown) => {
                        const msg =
                          err instanceof Error
                            ? err.message
                            : "Download failed";
                        toast.error(msg);
                      });
                    }}
                    type="button"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </>
              );
              const rowClass =
                "group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50";
              return (
                <li key={entry.id}>
                  {jump ? (
                    // biome-ignore lint/a11y/useSemanticElements: the row nests an <a> (download), and interactive elements can't nest — role="button" with key handling is the valid shape here.
                    <div
                      aria-label={`Go to message for ${entry.name}`}
                      className={cn(
                        rowClass,
                        "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                      )}
                      data-testid="files-row"
                      onClick={jump}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          jump();
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {rowBody}
                    </div>
                  ) : (
                    <div className={rowClass} data-testid="files-row">
                      {rowBody}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="shrink-0 text-2xs text-muted-foreground">
        <FileIcon className="mr-1 inline h-3 w-3 align-[-2px]" />
        {entries.length} file{entries.length === 1 ? "" : "s"} indexed
      </p>
    </div>
  );
}
