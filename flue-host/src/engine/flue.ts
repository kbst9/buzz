import { randomBytes } from "node:crypto";
import type { Provider } from "@earendil-works/pi-ai";
import { type AgentInstanceHandle, AgentRunError, init } from "@flue/runtime";
import { type Flue, sqlite, start } from "@flue/runtime/node";
import type { StopReason } from "../acp/protocol.js";
import { log } from "../log.js";
import { BuzzAgent } from "./agent.js";
import { translateChunk } from "./translate.js";
import { type AgentEngine, type SessionSeed, TurnFailedError } from "./types.js";

export interface FlueEngineOptions {
  /** Model specifier, e.g. `xai/grok-4` or `openai-codex/gpt-5.2-codex`. */
  model: string;
  /** SQLite path for Flue persistence; `:memory:` (the default) scopes state to the process — matching buzz-acp, which never reattaches sessions across respawns. */
  db?: string;
  /** Provider override for tests (a faux provider). Omitted registers every pi built-in, resolving credentials from the environment. */
  providers?: readonly Provider[];
}

interface SessionState {
  handle: AgentInstanceHandle;
  seed: SessionSeed;
  /** initialData seeds only the instance-creating dispatch; afterwards it is ignored, so send it exactly once. */
  seeded: boolean;
}

/** Boots the in-process Flue runtime and adapts it to the {@link AgentEngine} seam. */
export async function createFlueEngine(options: FlueEngineOptions): Promise<AgentEngine> {
  const runtime: Flue = await start({
    agents: [BuzzAgent],
    db: sqlite(options.db ?? ":memory:"),
    ...(options.providers ? { providers: options.providers } : {}),
  });
  const sessions = new Map<string, SessionState>();

  return {
    modelId: options.model,

    newSession(seed: SessionSeed): Promise<string> {
      const sessionId = `ses_${randomBytes(8).toString("hex")}`;
      sessions.set(sessionId, { handle: init(BuzzAgent, { id: sessionId }), seed, seeded: false });
      log.info("session created", { sessionId, cwd: seed.cwd });
      return Promise.resolve(sessionId);
    },

    hasSession(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    async prompt(sessionId, text, onUpdate): Promise<StopReason> {
      const session = sessions.get(sessionId);
      if (!session) throw new TurnFailedError(`unknown session: ${sessionId}`);

      const receipt = await session.handle.dispatch(
        session.seeded ? { message: text } : { message: text, initialData: session.seed },
      );
      session.seeded = true;

      try {
        await session.handle.read(receipt, {
          onEvent: (chunk) => {
            for (const update of translateChunk(chunk)) onUpdate(update);
          },
        });
        return "end_turn";
      } catch (cause) {
        if (cause instanceof AgentRunError && cause.outcome === "aborted") return "cancelled";
        throw new TurnFailedError(describe(cause), { cause });
      }
    },

    async cancel(sessionId): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        log.warn("cancel for unknown session", { sessionId });
        return;
      }
      try {
        await session.handle.abort();
      } catch (cause) {
        log.warn("abort failed", { sessionId, error: describe(cause) });
      }
    },

    async stop(): Promise<void> {
      await runtime.stop();
    },
  };
}

function describe(cause: unknown): string {
  if (cause instanceof AgentRunError) return `submission ${cause.outcome}: ${describe(cause.cause)}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
