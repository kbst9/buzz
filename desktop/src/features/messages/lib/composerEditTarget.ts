import {
  imetaMediaFromTags,
  type ImetaMedia,
} from "@/features/messages/lib/imetaMediaMarkdown";
import type { TimelineMessage } from "@/features/messages/types";

/** The composer's edit-mode payload: the fields it needs to seed an edit. */
export type ComposerEditTarget = {
  author: string;
  body: string;
  id: string;
  imetaMedia?: ImetaMedia[];
};

/**
 * Project a timeline message into the composer's edit target, carrying the
 * message's imeta media so attachment chips survive entering edit mode.
 */
export function composerEditTargetFromMessage(
  message: TimelineMessage | null,
): ComposerEditTarget | null {
  if (!message) return null;
  return {
    author: message.author,
    body: message.body,
    id: message.id,
    imetaMedia: imetaMediaFromTags(message.tags),
  };
}
