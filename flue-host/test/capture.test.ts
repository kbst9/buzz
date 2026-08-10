import { describe, expect, it } from "vitest";
import {
  createBoundedCapture,
  DEFAULT_MAX_EXEC_OUTPUT_BYTES,
  maxExecOutputBytes,
} from "../src/sandbox/capture.js";

/**
 * Bounded exec-output capture (resource blast-radius cap): the shared
 * helper both process tiers wire their exec streams through. Pins byte
 * accounting, the exceed-once kill signal, post-exceed dropping, and the
 * model-visible killed result.
 */

describe("createBoundedCapture", () => {
  it("accumulates stdout and stderr under the cap without firing", () => {
    let fired = 0;
    const capture = createBoundedCapture(1024);
    capture.onExceed = () => {
      fired += 1;
    };
    capture.append("stdout", "hello ");
    capture.append("stderr", "warn\n");
    capture.append("stdout", "world");
    expect(capture.stdout).toBe("hello world");
    expect(capture.stderr).toBe("warn\n");
    expect(capture.exceeded).toBe(false);
    expect(fired).toBe(0);
  });

  it("fires onExceed exactly once on the crossing append and drops later chunks", () => {
    let fired = 0;
    const capture = createBoundedCapture(10);
    capture.onExceed = () => {
      fired += 1;
    };
    capture.append("stdout", "12345678");
    expect(capture.exceeded).toBe(false);
    // Crosses 10 bytes: kept (memory stays bounded at cap + one pipe chunk).
    capture.append("stdout", "9012345");
    expect(capture.exceeded).toBe(true);
    expect(fired).toBe(1);
    expect(capture.stdout).toBe("123456789012345");
    // Everything after the kill signal is dropped — a fast writer cannot
    // keep growing the buffer during kill latency.
    capture.append("stdout", "MORE");
    capture.append("stderr", "MORE");
    expect(capture.stdout).toBe("123456789012345");
    expect(capture.stderr).toBe("");
    expect(fired).toBe(1);
  });

  it("counts bytes, not JS chars (stdout+stderr combined)", () => {
    const capture = createBoundedCapture(5);
    // 3 chars, 6 UTF-8 bytes — crosses a 5-byte cap; a char count would not.
    capture.append("stderr", "ééé");
    expect(capture.exceeded).toBe(true);

    const combined = createBoundedCapture(10);
    combined.append("stdout", "12345");
    combined.append("stderr", "67890");
    expect(combined.exceeded).toBe(false);
    combined.append("stderr", "x");
    expect(combined.exceeded).toBe(true);
  });

  it("killedResult carries the marker, captured output, and exit 1", () => {
    const capture = createBoundedCapture(4);
    capture.append("stdout", "out");
    capture.append("stderr", "err");
    expect(capture.exceeded).toBe(true);
    const result = capture.killedResult();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err\n[sandbox] output exceeded 4 bytes; command killed");
  });

  it("killedResult with empty stderr is the bare marker (no leading newline)", () => {
    const capture = createBoundedCapture(2);
    capture.append("stdout", "abc");
    expect(capture.killedResult().stderr).toBe(
      "[sandbox] output exceeded 2 bytes; command killed",
    );
  });

  it("works without an onExceed handler wired", () => {
    const capture = createBoundedCapture(1);
    expect(() => capture.append("stdout", "abc")).not.toThrow();
    expect(capture.exceeded).toBe(true);
  });
});

describe("maxExecOutputBytes", () => {
  it("defaults to Flue local()'s 64 MiB", () => {
    expect(maxExecOutputBytes({})).toBe(DEFAULT_MAX_EXEC_OUTPUT_BYTES);
    expect(DEFAULT_MAX_EXEC_OUTPUT_BYTES).toBe(67_108_864);
  });

  it("honors BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES", () => {
    expect(maxExecOutputBytes({ BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES: "1048576" })).toBe(1_048_576);
  });

  it("falls back to the default on garbage, zero, negative, or blank", () => {
    for (const value of ["nope", "0", "-5", "1.5", "", "  "]) {
      expect(maxExecOutputBytes({ BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES: value })).toBe(
        DEFAULT_MAX_EXEC_OUTPUT_BYTES,
      );
    }
  });
});
