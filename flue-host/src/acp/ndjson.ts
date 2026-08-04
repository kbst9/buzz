import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * NDJSON transport, matching buzz-acp's framing exactly: one JSON value per
 * `\n`-terminated line, blank lines skipped, every write flushed. No
 * Content-Length headers (this is not LSP framing).
 */

/** Yields one parsed JSON value per non-blank line. Malformed lines yield an error marker instead of throwing, so the read loop can log and continue the way buzz-acp does. */
export async function* readJsonLines(
  input: Readable,
): AsyncGenerator<{ value: unknown } | { parseError: string; line: string }> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      yield { value: JSON.parse(line) as unknown };
    } catch (cause) {
      yield { parseError: cause instanceof Error ? cause.message : String(cause), line };
    }
  }
}

/** Serializes one JSON value per line. Writes are synchronous with respect to ordering; Node's stream buffering handles backpressure. */
export class NdjsonWriter {
  constructor(private readonly output: Writable) {}

  write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
