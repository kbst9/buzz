import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { SandboxFactory, SessionEnv, ShellResult } from "@flue/runtime";
import { log } from "../log.js";
import type { SandboxTier, SandboxViolation, TierFactoryOptions } from "./types.js";

/**
 * Per-exec audit log (AGENT_OS_M0.md § M0.5) — the debug backbone every
 * tier gets for free. The registry wraps each tier with {@link auditingTier};
 * tiers themselves never log.
 *
 * One structured line per exec, info level:
 *   `[flue-acp] info sandbox exec {"v":1,"tier":…,"argv0":…,"cmd_sha256":…,
 *    "cwd":…,"ms":…,"exit":…,"violations":[…]}`
 *
 * Privacy: info level carries argv0 (first whitespace token, best-effort)
 * plus the command's sha256 — command lines can carry sensitive content, so
 * the full text appears at debug level only (`BUZZ_FLUE_LOG=debug`).
 * Violations arrive already normalized (invariant 3); the schema is
 * versioned (invariant 5) so later consumers — dashboards, kind-44200
 * metrics — key on `v`.
 */

export interface AuditLine {
  v: 1;
  tier: string;
  /** First whitespace-separated token of the command — a safe identifier. */
  argv0: string;
  /** sha256 (hex) of the full command text — correlate without carrying it. */
  cmd_sha256: string;
  /** Effective working directory of the exec. */
  cwd: string;
  /** Wall-clock duration. */
  ms: number;
  /** Exit code; null when the exec settled by rejection (abort/spawn error). */
  exit: number | null;
  /** Normalized violations raised while this exec ran. */
  violations: SandboxViolation[];
}

type AuditListener = (line: AuditLine) => void;

const listeners = new Set<AuditListener>();

/** Subscribe to audit lines (tests, future 44200 metrics). Returns unsubscribe. */
export function onAuditLine(listener: AuditListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Violations raised during an exec attach to that exec's audit line. */
const activeExecViolations = new AsyncLocalStorage<SandboxViolation[]>();

function argv0Of(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function emit(line: AuditLine): void {
  log.info("sandbox exec", line);
  for (const listener of listeners) listener(line);
}

function auditedExec(env: SessionEnv, tier: string): SessionEnv["exec"] {
  return (command, options) => {
    const violations: SandboxViolation[] = [];
    const started = Date.now();
    const cwd =
      options?.cwd === undefined
        ? env.cwd
        : env.resolvePath(options.cwd);
    const settle = (exit: number | null): void => {
      emit({
        v: 1,
        tier,
        argv0: argv0Of(command),
        cmd_sha256: sha256Hex(command),
        cwd,
        ms: Date.now() - started,
        exit,
        violations,
      });
    };
    log.debug("sandbox exec command", { cmd_sha256: sha256Hex(command), command });
    return activeExecViolations.run(violations, async (): Promise<ShellResult> => {
      try {
        const result = await env.exec(command, options);
        settle(result.exitCode);
        return result;
      } catch (cause) {
        settle(null);
        throw cause;
      }
    });
  };
}

function auditedSessionEnv(env: SessionEnv, tier: string): SessionEnv {
  return {
    exec: auditedExec(env, tier),
    readFile: (path) => env.readFile(path),
    readFileBuffer: (path) => env.readFileBuffer(path),
    writeFile: (path, content) => env.writeFile(path, content),
    stat: (path) => env.stat(path),
    readdir: (path) => env.readdir(path),
    exists: (path) => env.exists(path),
    mkdir: (path, options) => env.mkdir(path, options),
    rm: (path, options) => env.rm(path, options),
    cwd: env.cwd,
    resolvePath: (p) => env.resolvePath(p),
  };
}

/**
 * Wrap a tier so every exec of every session env it produces emits one
 * audit line, and violations raised mid-exec attach to that exec's line
 * (AsyncLocalStorage correlation). The caller's own `onViolation` keeps
 * firing — the wrapper chains, never replaces.
 */
export function auditingTier(tier: SandboxTier): SandboxTier {
  return {
    name: tier.name,
    capabilities: tier.capabilities,
    createFactory(options: TierFactoryOptions): SandboxFactory {
      const factory = tier.createFactory({
        ...options,
        onViolation: (violation) => {
          const active = activeExecViolations.getStore();
          if (active) active.push(violation);
          else log.warn("sandbox violation outside exec", violation);
          options.onViolation?.(violation);
        },
      });
      return {
        ...factory,
        createSessionEnv: async (envOptions) =>
          auditedSessionEnv(await factory.createSessionEnv(envOptions), tier.name),
      };
    },
  };
}
