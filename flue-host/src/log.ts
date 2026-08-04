/**
 * All diagnostics go to stderr: stdout carries newline-delimited JSON-RPC
 * frames exclusively, and a single stray log line there kills the turn
 * (buzz-acp treats unparseable stdout as a protocol error frame).
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold: number = LEVELS[(process.env["BUZZ_FLUE_LOG"] as Level) ?? "info"] ?? LEVELS.info;

function emit(level: Level, message: string, detail?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const suffix = detail === undefined ? "" : ` ${safeJson(detail)}`;
  process.stderr.write(`[flue-acp] ${level} ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (message: string, detail?: unknown): void => emit("debug", message, detail),
  info: (message: string, detail?: unknown): void => emit("info", message, detail),
  warn: (message: string, detail?: unknown): void => emit("warn", message, detail),
  error: (message: string, detail?: unknown): void => emit("error", message, detail),
};
