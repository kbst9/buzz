import * as React from "react";

/**
 * Per-channel composer and thread targeting state: the open thread's
 * expanded-reply set, the pending thread scroll target, the selected thread
 * reply target, and the message being edited — all reset together when the
 * active channel changes.
 *
 * Also owns the optimistic open-thread override: URL-backed thread state
 * catches up after navigation, and the override keeps urgent open/close
 * renders responsive until the route settles (or the channel changes).
 */
export function useChannelComposerTargets({
  activeChannelId,
  openThreadHeadId,
}: {
  activeChannelId: string | null;
  openThreadHeadId: string | null;
}): {
  editTargetId: string | null;
  effectiveOpenThreadHeadId: string | null;
  expandedThreadReplyIds: Set<string>;
  clearOptimisticThreadOverride: () => void;
  handleThreadScrollTargetResolved: () => void;
  setEditTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setExpandedThreadReplyIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setOptimisticOpenThreadHeadId: React.Dispatch<
    React.SetStateAction<string | null | undefined>
  >;
  setThreadReplyTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  setThreadScrollTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  threadReplyTargetId: string | null;
  threadScrollTargetId: string | null;
} {
  const [expandedThreadReplyIds, setExpandedThreadReplyIds] = React.useState(
    () => new Set<string>(),
  );
  const [threadScrollTargetId, setThreadScrollTargetId] = React.useState<
    string | null
  >(null);
  const [threadReplyTargetId, setThreadReplyTargetId] = React.useState<
    string | null
  >(null);
  const [editTargetId, setEditTargetId] = React.useState<string | null>(null);
  const [optimisticOpenThreadHeadId, setOptimisticOpenThreadHeadId] =
    React.useState<string | null | undefined>(undefined);
  const clearOptimisticThreadOverride = React.useCallback(() => {
    setOptimisticOpenThreadHeadId(undefined);
  }, []);
  const effectiveOpenThreadHeadId =
    optimisticOpenThreadHeadId === undefined
      ? openThreadHeadId
      : optimisticOpenThreadHeadId;
  const previousActiveChannelIdRef = React.useRef(activeChannelId);
  React.useEffect(() => {
    const didChangeChannel =
      previousActiveChannelIdRef.current !== activeChannelId;
    previousActiveChannelIdRef.current = activeChannelId;
    setOptimisticOpenThreadHeadId((current) => {
      if (current === undefined) {
        return current;
      }
      return didChangeChannel || openThreadHeadId === current
        ? undefined
        : current;
    });
  }, [activeChannelId, openThreadHeadId]);
  const resetComposerTargets = React.useCallback(
    (_channelId: string | null) => {
      setExpandedThreadReplyIds(new Set());
      setThreadScrollTargetId(null);
      setThreadReplyTargetId(null);
      setEditTargetId(null);
    },
    [],
  );
  React.useEffect(() => {
    resetComposerTargets(activeChannelId);
  }, [activeChannelId, resetComposerTargets]);
  const handleThreadScrollTargetResolved = React.useCallback(() => {
    setThreadScrollTargetId(null);
  }, []);

  return {
    editTargetId,
    effectiveOpenThreadHeadId,
    expandedThreadReplyIds,
    clearOptimisticThreadOverride,
    handleThreadScrollTargetResolved,
    setEditTargetId,
    setExpandedThreadReplyIds,
    setOptimisticOpenThreadHeadId,
    setThreadReplyTargetId,
    setThreadScrollTargetId,
    threadReplyTargetId,
    threadScrollTargetId,
  };
}
