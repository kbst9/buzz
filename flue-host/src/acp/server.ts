import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { log } from "../log.js";
import type { AgentEngine, SessionSeed } from "../engine/types.js";
import { TurnFailedError } from "../engine/types.js";
import { NdjsonWriter, readJsonLines } from "./ndjson.js";
import {
  type ContentBlock,
  errorFrame,
  INVALID_PARAMS,
  isRequestLike,
  type JsonRpcRequest,
  keepalive,
  type McpServerConfig,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  type RequestId,
  resultFrame,
  type SessionNewParams,
  type SessionPromptParams,
  sessionUpdateFrame,
  TURN_FAILED,
} from "./protocol.js";

/** BUZZ_* vars forwarded from our own environment into the sandbox so the `buzz` CLI authenticates — the same trust posture as today's native units. */
const SANDBOX_ENV_PASSTHROUGH = ["BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY", "BUZZ_AUTH_TAG", "BUZZ_ACP_DISPLAY_NAME"];

export interface AcpServerOptions {
  /** Reported as `agentInfo.version`. */
  version?: string;
  /** Keepalive cadence while a turn is in flight (buzz-agent uses 30s against buzz-acp's 900s idle clock). */
  keepaliveMs?: number;
}

/**
 * The ACP agent endpoint: reads NDJSON frames from `input`, drives the
 * engine, writes frames to `output`. The read loop never blocks on a turn —
 * `session/cancel` must be receivable while `session/prompt` is in flight.
 */
export class AcpServer {
  private readonly writer: NdjsonWriter;
  private readonly keepaliveMs: number;
  private readonly version: string;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly engine: AgentEngine,
    io: { input: Readable; output: Writable },
    options: AcpServerOptions = {},
  ) {
    this.input = io.input;
    this.writer = new NdjsonWriter(io.output);
    this.keepaliveMs = options.keepaliveMs ?? 30_000;
    this.version = options.version ?? "0.0.0";
  }

  private readonly input: Readable;

  /** Serves until the input stream ends, then drains in-flight turns. */
  async run(): Promise<void> {
    for await (const frame of readJsonLines(this.input)) {
      if ("parseError" in frame) {
        log.warn("unparseable frame", { error: frame.parseError });
        continue;
      }
      if (!isRequestLike(frame.value)) {
        log.debug("ignoring non-request frame");
        continue;
      }
      this.dispatch(frame.value as JsonRpcRequest);
    }
    await Promise.allSettled(this.inflight);
  }

  private dispatch(frame: JsonRpcRequest): void {
    const { method } = frame;
    const id: RequestId | undefined = frame.id;
    switch (method) {
      case "initialize":
        return this.onInitialize(id, frame.params);
      case "session/new":
        return this.track(this.onSessionNew(id, frame.params));
      case "session/prompt":
        return this.track(this.onSessionPrompt(id, frame.params));
      case "session/cancel":
        return this.onSessionCancel(id, frame.params);
      default:
        // Never answer unknown methods with success: buzz-acp treats a `{}`
        // reply to `_session/steering` as a delivered steer and would drop
        // the user's message. -32601 is the contract.
        if (id !== undefined) this.writer.write(errorFrame(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
        else log.debug("dropping unknown notification", { method });
    }
  }

  private track(turn: Promise<void>): void {
    this.inflight.add(turn);
    void turn.finally(() => this.inflight.delete(turn));
  }

  private onInitialize(id: RequestId | undefined, params: unknown): void {
    if (id === undefined) return;
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const negotiated = Math.min(typeof requested === "number" ? requested : 1, PROTOCOL_VERSION);
    this.writer.write(
      resultFrame(id, {
        protocolVersion: negotiated,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: "flue-acp", version: this.version },
      }),
    );
  }

  private async onSessionNew(id: RequestId | undefined, params: unknown): Promise<void> {
    if (id === undefined) return;
    const p = (params ?? {}) as Partial<SessionNewParams>;
    if (typeof p.cwd !== "string" || p.cwd.length === 0 || !isAbsolute(p.cwd)) {
      this.writer.write(errorFrame(id, INVALID_PARAMS, "session/new requires an absolute cwd"));
      return;
    }
    const seed: SessionSeed = {
      cwd: p.cwd,
      env: buildSandboxEnv(p.mcpServers ?? []),
      ...(typeof p.systemPrompt === "string" && p.systemPrompt.length > 0 ? { systemPrompt: p.systemPrompt } : {}),
    };
    try {
      const sessionId = await this.engine.newSession(seed);
      this.writer.write(
        resultFrame(id, {
          sessionId,
          models: {
            currentModelId: this.engine.modelId,
            availableModels: [{ modelId: this.engine.modelId, name: this.engine.modelId }],
          },
        }),
      );
    } catch (cause) {
      this.writer.write(errorFrame(id, TURN_FAILED, `session/new failed: ${message(cause)}`));
    }
  }

  private async onSessionPrompt(id: RequestId | undefined, params: unknown): Promise<void> {
    if (id === undefined) return;
    const p = (params ?? {}) as Partial<SessionPromptParams>;
    const sessionId = p.sessionId;
    if (typeof sessionId !== "string" || !this.engine.hasSession(sessionId)) {
      this.writer.write(errorFrame(id, INVALID_PARAMS, "session/prompt for unknown sessionId"));
      return;
    }
    const text = promptText(p.prompt ?? []);
    if (text.length === 0) {
      this.writer.write(errorFrame(id, INVALID_PARAMS, "session/prompt carried no text content"));
      return;
    }

    const heartbeat = setInterval(() => this.writer.write(sessionUpdateFrame(sessionId, keepalive)), this.keepaliveMs);
    heartbeat.unref?.();
    try {
      const stopReason = await this.engine.prompt(sessionId, text, (update) =>
        this.writer.write(sessionUpdateFrame(sessionId, update)),
      );
      this.writer.write(resultFrame(id, { stopReason }));
    } catch (cause) {
      const detail = cause instanceof TurnFailedError ? cause.message : message(cause);
      log.error("turn failed", { sessionId, error: detail });
      this.writer.write(errorFrame(id, TURN_FAILED, detail));
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Cancel arrives as a notification; some clients send it as a request — answer those with `null` (buzz-agent's cheap insurance). The in-flight prompt still gets its `cancelled` stopReason via the engine. */
  private onSessionCancel(id: RequestId | undefined, params: unknown): void {
    const sessionId = (params as Partial<SessionPromptParams> | undefined)?.sessionId;
    if (typeof sessionId === "string") void this.engine.cancel(sessionId);
    else log.warn("session/cancel without sessionId");
    if (id !== undefined) this.writer.write(resultFrame(id, null));
  }
}

/**
 * flue-acp does not spawn stdio MCP servers: Flue serves the coding toolset
 * natively over the sandbox, and the `buzz` CLI provides the Buzz surface
 * from within it. What the declared servers do carry — the BUZZ_* auth env —
 * is exactly what that sandbox shell needs, so forward it.
 */
function buildSandboxEnv(servers: McpServerConfig[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SANDBOX_ENV_PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) env[name] = value;
  }
  for (const server of servers) {
    log.warn("stdio MCP server not spawned; env forwarded to sandbox", { server: server.name });
    for (const { name, value } of server.env ?? []) env[name] = value;
  }
  return env;
}

function promptText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => typeof block.text === "string" && block.text.length > 0)
    .map((block) => block.text as string)
    .join("\n\n");
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
