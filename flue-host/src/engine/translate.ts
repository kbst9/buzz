import type { ConversationStreamChunk } from "@flue/runtime";
import {
  agentMessageChunk,
  agentThoughtChunk,
  type SessionUpdateBody,
  toolCallCompleted,
  toolCallFailed,
  toolCallProgress,
  toolCallStart,
} from "../acp/protocol.js";

/**
 * Flue conversation-stream chunks → ACP `session/update` bodies.
 *
 * buzz-acp treats updates as telemetry (observer frames, idle-clock resets),
 * not delivery — the user-visible reply happens through the sandboxed `buzz`
 * CLI — so fidelity here serves the desktop transcript: text and reasoning
 * deltas stream as chunks (the client coalesces by messageId), tool calls
 * follow buzz-agent's pending → in_progress → completed/failed shape, and
 * the initial `tool_call` doubles as the idle-clock reset before a long
 * tool run.
 */
export function translateChunk(chunk: ConversationStreamChunk): SessionUpdateBody[] {
  switch (chunk.type) {
    case "message-delta":
      return chunk.kind === "reasoning"
        ? [agentThoughtChunk(chunk.delta, chunk.messageId)]
        : [agentMessageChunk(chunk.delta, chunk.messageId)];
    case "tool-input":
      return [toolCallStart(chunk.toolCallId, chunk.toolName, chunk.input), toolCallProgress(chunk.toolCallId)];
    case "tool-output":
      return [toolCallCompleted(chunk.toolCallId, renderOutput(chunk.output))];
    case "tool-output-error":
      return [toolCallFailed(chunk.toolCallId, chunk.errorText)];
    default:
      // Boundary/bookkeeping chunks (message-started/-completed, snapshots,
      // settlement, data parts) have no ACP counterpart buzz-acp consumes.
      return [];
  }
}

function renderOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}
