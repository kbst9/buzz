import type { SessionUpdateBody, StopReason } from "../acp/protocol.js";

/** Everything a new ACP session needs to seed its Flue agent instance. */
export interface SessionSeed {
  /** Absolute workspace path from `session/new.cwd` — the nest. Roots the sandbox. */
  cwd: string;
  /** The framed system prompt buzz-acp delivers on the v2 path. */
  systemPrompt?: string;
  /** Env exposed to the sandbox shell (`buzz` CLI auth etc.). Merged from the process env's BUZZ_* vars and any env declared on `session/new.mcpServers`. */
  env: Record<string, string>;
}

/** A prompt turn that settled `failed` — surfaced to buzz-acp as a JSON-RPC error so the message reaches its auth-failure pattern matching and logs. */
export class TurnFailedError extends Error {}

/**
 * The engine seam the ACP server drives. One implementation runs real Flue
 * (`FlueEngine`); tests may substitute a stub to exercise the protocol layer
 * in isolation.
 */
export interface AgentEngine {
  /** The model specifier served, reported in `session/new.result.models`. */
  readonly modelId: string;
  /** Mints a session and prepares its (lazily seeded) agent instance. */
  newSession(seed: SessionSeed): Promise<string>;
  /** Runs one turn; streams translated updates; resolves with the stopReason. Rejects with {@link TurnFailedError} when the submission settles failed. */
  prompt(sessionId: string, text: string, onUpdate: (update: SessionUpdateBody) => void): Promise<StopReason>;
  /** Durably aborts the session's running and queued work. The in-flight prompt() then resolves with "cancelled". */
  cancel(sessionId: string): Promise<void>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
  /** True when the session id was minted by newSession. */
  hasSession(sessionId: string): boolean;
}
