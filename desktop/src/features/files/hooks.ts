import * as React from "react";

import {
  type FileIndexEntry,
  parseFileIndexEvent,
  retractedFileIndexIds,
  sortFileEntries,
} from "@/features/files/lib/fileIndex";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_DELETION, KIND_FILE_METADATA } from "@/shared/constants/kinds";

const HISTORY_PAGE_LIMIT = 200;

type ChannelFilesState = {
  entries: FileIndexEntry[];
  isLoading: boolean;
  hasError: boolean;
};

/**
 * The relay-derived file index for one channel: initial history fetch plus a
 * live subscription that appends new kind-1063 entries and drops entries
 * retracted by relay-signed kind-5 (`k 1063`) events.
 *
 * Queries are always channel-scoped (`#h`) — the community Files view calls
 * this hook per expanded channel; an unscoped kinds-only query must never
 * exist (see docs/channel-files-explorer.md § Privacy).
 */
export function useChannelFiles(
  channelId: string | null,
  options: { enabled?: boolean } = {},
): ChannelFilesState & { refresh: () => void } {
  const enabled = options.enabled ?? true;
  const [state, setState] = React.useState<ChannelFilesState>({
    entries: [],
    isLoading: false,
    hasError: false,
  });
  const [refreshNonce, setRefreshNonce] = React.useState(0);

  React.useEffect(() => {
    // Referenced so the manual-refresh nonce is a real dependency.
    void refreshNonce;
    if (!channelId || !enabled) {
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    const byId = new Map<string, FileIndexEntry>();

    const publish = () => {
      if (cancelled) return;
      setState({
        entries: sortFileEntries([...byId.values()]),
        isLoading: false,
        hasError: false,
      });
    };

    const onLiveEvent = (event: RelayEvent) => {
      if (event.kind === KIND_FILE_METADATA) {
        const entry = parseFileIndexEvent(event);
        if (entry) {
          byId.set(entry.id, entry);
          publish();
        }
        return;
      }
      const retracted = retractedFileIndexIds(event);
      if (retracted.length > 0) {
        let changed = false;
        for (const id of retracted) {
          changed = byId.delete(id) || changed;
        }
        if (changed) publish();
      }
    };

    setState((prev) => ({ ...prev, isLoading: true, hasError: false }));
    void (async () => {
      try {
        const history = await relayClient.fetchEvents({
          kinds: [KIND_FILE_METADATA],
          "#h": [channelId],
          limit: HISTORY_PAGE_LIMIT,
        });
        if (cancelled) return;
        for (const event of history) {
          const entry = parseFileIndexEvent(event);
          if (entry) byId.set(entry.id, entry);
        }
        publish();
        unsubscribe = await relayClient.subscribeLive(
          {
            kinds: [KIND_FILE_METADATA, KIND_DELETION],
            "#h": [channelId],
            limit: 1,
          },
          onLiveEvent,
        );
        if (cancelled && unsubscribe) {
          void unsubscribe();
        }
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, isLoading: false, hasError: true }));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) {
        void unsubscribe();
      }
    };
  }, [channelId, enabled, refreshNonce]);

  const refresh = React.useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  return { ...state, refresh };
}
