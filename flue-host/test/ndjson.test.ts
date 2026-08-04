import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { NdjsonWriter, readJsonLines } from "../src/acp/ndjson.js";

describe("NDJSON transport", () => {
  it("round-trips one JSON value per line, skipping blanks, surviving malformed lines", async () => {
    const stream = new PassThrough();
    stream.write('{"a":1}\n');
    stream.write("\n");
    stream.write("   \n");
    stream.write("not json\n");
    stream.write('{"b":2}\n');
    stream.end();

    const seen: unknown[] = [];
    for await (const frame of readJsonLines(stream)) seen.push(frame);
    expect(seen).toEqual([
      { value: { a: 1 } },
      expect.objectContaining({ parseError: expect.any(String), line: "not json" }),
      { value: { b: 2 } },
    ]);
  });

  it("writes newline-terminated frames", () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (chunk: Buffer) => chunks.push(chunk));
    const writer = new NdjsonWriter(out);
    writer.write({ jsonrpc: "2.0", id: 0, result: null });
    writer.write({ jsonrpc: "2.0", method: "session/update" });
    expect(Buffer.concat(chunks).toString()).toBe(
      '{"jsonrpc":"2.0","id":0,"result":null}\n{"jsonrpc":"2.0","method":"session/update"}\n',
    );
  });
});
