import * as React from "react";

import type { DraftMentionRef } from "./useDrafts";

import { trimMapToSize } from "@/shared/lib/trimMapToSize";
import {
  replaceWithDraftMentionRefs,
  snapshotDraftMentionRefs,
} from "./draftMentionRefs";

export function useDraftMentionRouting(params: {
  mentionMapRef: React.MutableRefObject<Map<string, string>>;
  personaMentionMapRef: React.MutableRefObject<Map<string, string>>;
  /** Swarm display name → swarm id (§2.1); snapshotted alongside pubkeys. */
  swarmMentionMapRef: React.MutableRefObject<Map<string, string>>;
  selectedAgentNamesRef: React.MutableRefObject<string[]>;
  cancelAutocomplete: () => void;
  setSelectedNames: (names: string[]) => void;
  setSelectedAgentNames: (names: string[]) => void;
}): {
  getDraftMentionRefs: (content: string) => DraftMentionRef[];
  restoreDraftMentionRefs: (refs: readonly DraftMentionRef[]) => void;
} {
  const getDraftMentionRefs = React.useCallback(
    (content: string) =>
      snapshotDraftMentionRefs(
        content,
        params.mentionMapRef.current,
        params.selectedAgentNamesRef.current,
        params.swarmMentionMapRef.current,
      ),
    [
      params.mentionMapRef,
      params.selectedAgentNamesRef,
      params.swarmMentionMapRef,
    ],
  );
  const restoreDraftMentionRefs = React.useCallback(
    (refs: readonly DraftMentionRef[]) => {
      params.cancelAutocomplete();
      const { names, agentNames } = replaceWithDraftMentionRefs(
        refs,
        params.mentionMapRef.current,
        params.personaMentionMapRef.current,
        params.swarmMentionMapRef.current,
      );
      trimMapToSize(params.mentionMapRef.current, 200);
      params.selectedAgentNamesRef.current = agentNames;
      params.setSelectedNames(names);
      params.setSelectedAgentNames(agentNames);
    },
    [params],
  );
  return { getDraftMentionRefs, restoreDraftMentionRefs };
}
