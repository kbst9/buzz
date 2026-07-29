/**
 * Pure decision for which per-message moderation entries the message menu
 * (`MessageModerationMenuItems`) offers against a message author. Extracted
 * so the policy is testable without rendering the menu.
 */

/** Which moderation entries the per-message menu offers. */
export type MessageModerationItems = {
  /** Kick the author from the current channel. */
  kick: boolean;
  /** Restriction entries: time out / lift timeout, ban / lift ban. */
  restrict: boolean;
};

/**
 * Community ban/timeout applies to people, never agents — the same exemption
 * the members sidebar enforces (`canModerateMember = canModerate &&
 * !memberIsBot && ...` in `MembersSidebarMemberCard`). A misbehaving agent is
 * its owner's to stop or remove, so restriction entries are withheld on
 * agent-authored messages. Kick stays available for agents: the sidebar
 * likewise offers "Remove from channel" for bots.
 */
export function resolveMessageModerationItems(input: {
  /** The message author is an agent. */
  authorIsAgent: boolean;
  /** Viewer holds a relay owner/admin role. */
  canModerate: boolean;
  /** A channel context exists to kick from. */
  hasChannel: boolean;
  /** The message has a real signer pubkey to act on. */
  hasTarget: boolean;
  /** The signer is the viewer themself. */
  isSelf: boolean;
}): MessageModerationItems {
  const canActOnAuthor = input.canModerate && input.hasTarget && !input.isSelf;
  return {
    kick: canActOnAuthor && input.hasChannel,
    restrict: canActOnAuthor && !input.authorIsAgent,
  };
}
