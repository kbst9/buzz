import type { RelayEvent } from "@/shared/api/types";
import { KIND_DELETION, KIND_FILE_METADATA } from "@/shared/constants/kinds";

/** Broad type buckets used by the filter chips (desktop) and `buzz files`. */
export type FileTypeClass = "image" | "video" | "audio" | "doc";

/** One parsed relay-derived kind-1063 file-index entry. */
export type FileIndexEntry = {
  /** Index event id (retraction target). */
  id: string;
  /** Display name: content (filename → alt) with URL-tail fallback. */
  name: string;
  url: string;
  mime: string;
  typeClass: FileTypeClass;
  sizeBytes: number | null;
  sha256: string;
  thumb: string | null;
  /** Source message share time (seconds); emission time as fallback. */
  sharedAt: number;
  /** Sharer pubkey hex (custom `uploader` tag — deliberately not `p`). */
  uploader: string | null;
  /** Source message event id (`e` tag) for jump-to-message. */
  messageId: string | null;
  channelId: string | null;
};

export function fileTypeClass(mime: string): FileTypeClass {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "doc";
}

function tagValue(tags: string[][], key: string): string | null {
  for (const tag of tags) {
    if (tag[0] === key && typeof tag[1] === "string" && tag[1].length > 0) {
      return tag[1];
    }
  }
  return null;
}

/**
 * Parse a kind-1063 index event. Returns null for anything malformed —
 * agent-shared files may lack a filename (the CLI does not emit one yet),
 * so the display name falls back to the URL tail.
 */
export function parseFileIndexEvent(event: RelayEvent): FileIndexEntry | null {
  if (event.kind !== KIND_FILE_METADATA) return null;
  const url = tagValue(event.tags, "url");
  const mime = tagValue(event.tags, "m");
  const sha256 = tagValue(event.tags, "x");
  if (!url || !mime || !sha256) return null;

  const sizeRaw = tagValue(event.tags, "size");
  const sizeBytes =
    sizeRaw !== null ? Number.parseInt(sizeRaw, 10) : Number.NaN;
  const sharedAtRaw = tagValue(event.tags, "shared_at");
  const sharedAt =
    sharedAtRaw !== null ? Number.parseInt(sharedAtRaw, 10) : Number.NaN;

  const urlTail = url.split("/").pop() ?? url;
  const name =
    event.content.trim() || tagValue(event.tags, "filename") || urlTail;

  return {
    id: event.id,
    name,
    url,
    mime,
    typeClass: fileTypeClass(mime),
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    sha256,
    thumb: tagValue(event.tags, "thumb"),
    sharedAt: Number.isFinite(sharedAt) ? sharedAt : event.created_at,
    uploader: tagValue(event.tags, "uploader"),
    messageId: tagValue(event.tags, "e"),
    channelId: tagValue(event.tags, "h"),
  };
}

/**
 * Index-entry ids retracted by a relay-signed kind-5. The `k 1063` tag is
 * the cheap routing marker; without it the deletion is not index-related.
 */
export function retractedFileIndexIds(event: RelayEvent): string[] {
  if (event.kind !== KIND_DELETION) return [];
  if (tagValue(event.tags, "k") !== String(KIND_FILE_METADATA)) return [];
  return event.tags
    .filter((tag) => tag[0] === "e" && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

/** Newest share first; entry id as a stable tiebreak. */
export function sortFileEntries(entries: FileIndexEntry[]): FileIndexEntry[] {
  return [...entries].sort(
    (a, b) => b.sharedAt - a.sharedAt || a.id.localeCompare(b.id),
  );
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
