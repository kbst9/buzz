/**
 * Pure parsing for owner-authored kind:30177 connected-agent definitions —
 * no app imports so node tests can exercise it directly. The fetch/query
 * layer lives in `connectedAgentDefinition.ts`.
 */

export interface ConnectedAgentDefinition {
  name: string | null;
  instructions: string;
}

const EMPTY_DEFINITION: ConnectedAgentDefinition = {
  name: null,
  instructions: "",
};

/**
 * Parse a kind:30177 content body into the fields the Instructions editor
 * cares about. Forgiving by design: unknown fields are ignored (the desktop
 * publishes a richer projection for managed agents) and malformed JSON
 * yields the empty definition — an unreadable definition edits like a
 * missing one.
 */
export function parseConnectedAgentDefinition(
  content: string | null | undefined,
): ConnectedAgentDefinition {
  if (!content) {
    return EMPTY_DEFINITION;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      return EMPTY_DEFINITION;
    }
    const body = parsed as { name?: unknown; system_prompt?: unknown };
    return {
      name:
        typeof body.name === "string" && body.name.trim() !== ""
          ? body.name
          : null,
      instructions:
        typeof body.system_prompt === "string" ? body.system_prompt : "",
    };
  } catch {
    return EMPTY_DEFINITION;
  }
}
