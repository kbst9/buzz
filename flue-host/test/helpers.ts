import { PassThrough } from "node:stream";
import { AcpServer, type AcpServerOptions } from "../src/acp/server.js";
import { readJsonLines } from "../src/acp/ndjson.js";
import type { AgentEngine } from "../src/engine/types.js";

/** Drives an AcpServer over in-memory pipes the way buzz-acp drives a child process: NDJSON in, NDJSON out. */
export class TestClient {
  private readonly input = new PassThrough();
  private readonly frames: unknown[] = [];
  private notify: (() => void) | null = null;
  readonly done: Promise<void>;
  private nextId = 0;

  constructor(engine: AgentEngine, options: AcpServerOptions = {}) {
    const output = new PassThrough();
    const server = new AcpServer(engine, { input: this.input, output }, options);
    void this.collect(output);
    this.done = server.run();
  }

  private async collect(output: PassThrough): Promise<void> {
    for await (const frame of readJsonLines(output)) {
      if ("value" in frame) {
        this.frames.push(frame.value);
        this.notify?.();
      }
    }
  }

  send(frame: object): void {
    this.input.write(`${JSON.stringify(frame)}\n`);
  }

  /** Sends a request with a fresh numeric id (buzz-acp's single shared counter) and returns the id. */
  request(method: string, params?: unknown): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  notification(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** All frames observed so far. */
  observed(): readonly unknown[] {
    return this.frames;
  }

  /** Resolves with the first frame matching the predicate; scans past frames first. */
  async waitFor<T = Record<string, unknown>>(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<T> {
    const matches = (frame: unknown): frame is Record<string, unknown> =>
      typeof frame === "object" && frame !== null && predicate(frame as Record<string, unknown>);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(matches);
      if (found) return found as T;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for frame; saw: ${JSON.stringify(this.frames, null, 2)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.notify = () => {
          clearTimeout(timer);
          this.notify = null;
          resolve();
        };
      });
    }
  }

  /** Resolves with the response frame for a request id. */
  async response(id: number, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.waitFor((frame) => frame["id"] === id && !("method" in frame), timeoutMs);
  }

  /** All `session/update` bodies observed so far, in order. */
  updates(): Record<string, unknown>[] {
    return this.frames
      .filter(
        (frame): frame is { params: { update: Record<string, unknown> } } =>
          typeof frame === "object" && frame !== null && (frame as { method?: string }).method === "session/update",
      )
      .map((frame) => frame.params.update);
  }

  close(): void {
    this.input.end();
  }
}
