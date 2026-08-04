/**
 * The subset of the Agent Client Protocol that buzz-acp actually speaks,
 * transcribed from crates/buzz-acp/src/acp.rs and crates/buzz-agent (the
 * in-repo reference agent). Buzz squats protocolVersion 2 ahead of the
 * upstream ACP RFD; version 2 is what moves the system prompt into
 * `session/new.systemPrompt` on the generic agent path.
 */

export const PROTOCOL_VERSION = 2;

// JSON-RPC ------------------------------------------------------------------

export type RequestId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Inbound frames: a `method` field marks a request/notification — a frame with an id but no method is a response (buzz-acp relies on exactly this rule). */
export function isRequestLike(frame: unknown): frame is JsonRpcRequest | JsonRpcNotification {
  return typeof frame === "object" && frame !== null && typeof (frame as { method?: unknown }).method === "string";
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const TURN_FAILED = -32000;

export function resultFrame(id: RequestId, result: unknown): JsonRpcNotification | JsonRpcRequest | object {
  return { jsonrpc: "2.0", id, result };
}

export function errorFrame(id: RequestId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ACP params ----------------------------------------------------------------

/** `env` is an array of `{name, value}` pairs on the wire — not a map. */
export interface McpEnvVar {
  name: string;
  value: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: McpEnvVar[];
}

export interface SessionNewParams {
  cwd: string;
  mcpServers?: McpServerConfig[];
  /** Present on the generic protocol-v2 path. Dropping it silently loses the persona — apply it always. */
  systemPrompt?: string;
  _meta?: { sessionTitle?: string };
}

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface SessionIdParams {
  sessionId: string;
}

/** The stopReason values buzz-acp parses (case-insensitively). Anything else is a protocol error that fails the turn. */
export type StopReason = "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";

// session/update bodies ------------------------------------------------------

/** One `session/update` payload body; the discriminator lives inside `update`. */
export type SessionUpdateBody = Record<string, unknown> & { sessionUpdate: string };

export function sessionUpdateFrame(sessionId: string, update: SessionUpdateBody): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId, update } };
}

export const keepalive: SessionUpdateBody = { sessionUpdate: "keepalive" };

export function agentMessageChunk(text: string, messageId?: string): SessionUpdateBody {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) };
}

export function agentThoughtChunk(text: string, messageId?: string): SessionUpdateBody {
  return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) };
}

export function toolCallStart(toolCallId: string, title: string, rawInput: unknown): SessionUpdateBody {
  return { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "pending", rawInput };
}

export function toolCallProgress(toolCallId: string): SessionUpdateBody {
  return { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" };
}

export function toolCallCompleted(toolCallId: string, outputText: string): SessionUpdateBody {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: outputText } }],
    rawOutput: { isError: false },
  };
}

export function toolCallFailed(toolCallId: string, error: string): SessionUpdateBody {
  return { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { error } };
}
