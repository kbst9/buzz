import type { ShellResult } from "@flue/runtime";
import { log } from "../log.js";

/**
 * Bounded exec-output capture. Both process tiers (`srt`, `docker`)
 * accumulate an exec's stdout/stderr in flue-acp's heap, and the
 * model-facing truncation happens only downstream in the result formatter —
 * so without a host-side cap, one `yes`-style flooder (or several at once:
 * Flue runs tool calls in parallel within a turn) can OOM the host process.
 * Flue's own `local()` tier caps output at 64 MiB and kills the process
 * tree; this helper restores that pattern for the fork's tiers, byte-counted
 * and shared so both behave identically.
 *
 * Semantics: bytes (not JS chars) are counted across stdout+stderr combined.
 * The append that crosses the cap is kept — a pipe chunk is ≤64 KiB, so
 * memory stays bounded at cap + one chunk — `onExceed` fires exactly once
 * (wire it to the exec's SIGTERM→SIGKILL path), and every later chunk is
 * dropped so a fast writer can't keep growing the buffer during kill
 * latency.
 */

/** 64 MiB — matches Flue `local()`'s MAX_OUTPUT_BYTES. */
export const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 67_108_864;

/** Host-side per-exec output cap; `BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES` overrides. */
export function maxExecOutputBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env["BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_EXEC_OUTPUT_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log.warn("ignoring invalid BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES", { value: raw });
    return DEFAULT_MAX_EXEC_OUTPUT_BYTES;
  }
  return parsed;
}

export interface BoundedCapture {
  /**
   * Fired once, on the append that crosses the cap. The exec function sets
   * this to its kill path (the capture is created by the session env — which
   * needs `exceeded` afterward for the audit violation — while the kill
   * machinery only exists inside the exec function).
   */
  onExceed: (() => void) | undefined;
  /** Accumulate a decoded chunk; drops everything once the cap is crossed. */
  append(target: "stdout" | "stderr", chunk: string): void;
  readonly stdout: string;
  readonly stderr: string;
  readonly exceeded: boolean;
  readonly maxBytes: number;
  /**
   * The ShellResult for a capped exec: output captured so far, the
   * truncation marker on stderr, and a non-zero exit — a reactable tool
   * error, same shape as a timeout or container kill.
   */
  killedResult(): ShellResult;
}

class BoundedCaptureImpl implements BoundedCapture {
  onExceed: (() => void) | undefined;
  #stdout = "";
  #stderr = "";
  #bytes = 0;
  #exceeded = false;

  constructor(readonly maxBytes: number) {}

  append(target: "stdout" | "stderr", chunk: string): void {
    if (this.#exceeded) return;
    this.#bytes += Buffer.byteLength(chunk, "utf8");
    if (target === "stdout") this.#stdout += chunk;
    else this.#stderr += chunk;
    if (this.#bytes > this.maxBytes) {
      this.#exceeded = true;
      this.onExceed?.();
    }
  }

  get stdout(): string {
    return this.#stdout;
  }

  get stderr(): string {
    return this.#stderr;
  }

  get exceeded(): boolean {
    return this.#exceeded;
  }

  killedResult(): ShellResult {
    const marker = `[sandbox] output exceeded ${this.maxBytes} bytes; command killed`;
    return {
      stdout: this.#stdout,
      stderr: this.#stderr ? `${this.#stderr}\n${marker}` : marker,
      exitCode: 1,
    };
  }
}

/** New capture for one exec, capped at `maxBytes` (default: env-configured). */
export function createBoundedCapture(maxBytes: number = maxExecOutputBytes()): BoundedCapture {
  return new BoundedCaptureImpl(maxBytes);
}
