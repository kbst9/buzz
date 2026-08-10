import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { FileStat, SessionEnv, ShellResult } from "@flue/runtime";
import { log } from "../log.js";
import { type BoundedCapture, createBoundedCapture } from "./capture.js";
import { DEFAULT_EGRESS, resolveEgress } from "./egress.js";
import { InitChain } from "./initchain.js";
import type { SandboxTier, SandboxViolation, TierFactoryOptions } from "./types.js";

/**
 * The `srt` light tier: Anthropic Sandbox Runtime (bwrap on Linux,
 * sandbox-exec on macOS) wrapping every tool exec. Native binaries and git
 * run untouched; egress is deny-by-default with our allowlist enforced by
 * srt's empty-netns + UDS proxy; the sandboxed shell cannot read host
 * secrets outside the workspace.
 *
 * **`allowAllUnixSockets: true` is deliberate** (verified on gradient
 * 2026-08-10): it makes srt skip the apply-seccomp step, whose nested
 * user namespace is blocked by Ubuntu's
 * `apparmor_restrict_unprivileged_userns=1` (the apt bwrap AppArmor profile
 * confines the nested userns regardless of the global sysctl). The egress
 * allowlist and FS scoping — the two things this tier delivers — are
 * enforced by bwrap's netns + proxy + bind mounts, NOT by that seccomp
 * filter; only the AF_UNIX defense-in-depth layer is dropped. Re-enabling it
 * needs a host-security change (disable the bwrap AppArmor profile +
 * sysctl=0) and is tracked as a follow-up, not required for the light tier.
 *
 * srt's global `SandboxManager` is a process singleton whose proxy enforces
 * the allowlist fixed at `initialize()` (per-exec `customConfig` does NOT
 * change egress — verified). That matches production exactly: one flue-acp
 * process serves one agent with one policy. Conformance drives several
 * policies in one process, so we re-init when the policy signature changes.
 */

/** Concrete srt policy derived from a factory's TierFactoryOptions. */
interface SrtPolicy {
  cwd: string;
  allowedDomains: string[];
}

const KILL_GRACE_MS = 2_000;

/**
 * Shell-essential host vars the sandbox may inherit (Ring 2 allowlist,
 * mirroring Flue's `local()`). Nothing sensitive belongs here — secrets,
 * tokens, and the agent key reach the sandbox ONLY via the seed env
 * (BUZZ_*). srt's own returned env derives from `process.env`, so we rebuild
 * the sandbox env from this allowlist + the seed + srt's added proxy vars,
 * and drop everything else (host secrets, `CANARY_HOST_SECRET`, …).
 */
const HOST_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

/**
 * Build the sandboxed process env: the host allowlist + the seed env
 * (BUZZ_*) + only the vars srt ADDED relative to `process.env` (its proxy
 * wiring: HTTP(S)_PROXY, socket paths, CA cert, …). Host env not on the
 * allowlist is dropped — the secret-canary guarantee.
 */
function buildSandboxEnv(
  seedEnv: Record<string, string>,
  srtEnv: NodeJS.ProcessEnv,
  perExecEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  Object.assign(out, seedEnv);
  // srt's proxy vars: keys it added or changed relative to the host env.
  for (const [key, value] of Object.entries(srtEnv)) {
    if (value !== undefined && value !== process.env[key]) out[key] = value;
  }
  if (perExecEnv) Object.assign(out, perExecEnv);
  return out;
}

function policySignature(policy: SrtPolicy): string {
  return JSON.stringify([policy.cwd, [...policy.allowedDomains].sort()]);
}

function buildSrtConfig(policy: SrtPolicy): SandboxRuntimeConfig {
  const home = process.env["HOME"];
  // Deny the run-user home (SSH keys, other agents' env) and classic secret
  // stores; re-allow the workspace via allowRead precedence (srt read is
  // deny-then-allow). Reads elsewhere (system dirs, tool libs) stay default-
  // allowed so native git/buzz keep working.
  const denyRead = [
    ...(home ? [home] : []),
    "/root",
    "/etc/shadow",
    "/etc/ssl/private",
  ];
  return {
    network: {
      allowedDomains: policy.allowedDomains,
      deniedDomains: [],
      // See the file-level note: required on the AppArmor-restricted host;
      // egress is still enforced by netns + proxy.
      allowAllUnixSockets: true,
    },
    filesystem: {
      denyRead,
      allowRead: [policy.cwd],
      // Allow-only: the workspace and /tmp are the sole writable roots.
      allowWrite: [policy.cwd, "/tmp"],
      denyWrite: [],
    },
  };
}

/**
 * Serialize init/re-init of the process-global SandboxManager. `current`
 * holds the signature the manager is initialized with; a factory whose
 * signature differs triggers reset()+initialize(). In production this runs
 * exactly once (all sessions share one policy). The InitChain retries a
 * failed init on the next call instead of poisoning the chain.
 */
let current: string | undefined;
const initChain = new InitChain("srt sandbox");

function ensureManager(policy: SrtPolicy): Promise<void> {
  const signature = policySignature(policy);
  return initChain.run(signature, async () => {
    if (current === signature) return;
    // Honest state at every await point: once we decide to (re)build, the
    // manager is no longer validly initialized — a failure below must leave
    // the next attempt starting from scratch, not trusting a stale `current`.
    current = undefined;
    // reset() is defensively conditional internally: a no-op on a pristine
    // manager, and it tears down half-initialized state after a failed
    // attempt (e.g. initialized but the network proxy never came up).
    await SandboxManager.reset();
    await SandboxManager.initialize(buildSrtConfig(policy));
    const ready = await SandboxManager.waitForNetworkInitialization();
    if (!ready) throw new Error("srt: network proxy failed to initialize");
    current = signature;
    log.info("srt sandbox initialized", {
      cwd: policy.cwd,
      allowedDomains: policy.allowedDomains,
    });
  });
}

/** Map srt's native violation lines into our normalized shape (invariant 3). */
function normalizeViolations(
  lines: readonly { line?: string }[],
  tier: string,
): SandboxViolation[] {
  const out: SandboxViolation[] = [];
  for (const { line } of lines) {
    if (!line) continue;
    // srt egress denial: "deny network-outbound <host>:<port> (host is not on the allow list)"
    const egress = /network-outbound\s+([^\s(]+)/.exec(line);
    if (egress?.[1]) {
      out.push({ kind: "egress", tier, target: egress[1], nativeDetail: line });
      continue;
    }
    // srt filesystem denial surfaces as an EPERM/"Operation not permitted"
    // on a path; capture the path when present.
    const fsDenied = /(?:EPERM|not permitted|operation not permitted)[^/]*(\/\S+)?/i.exec(line);
    if (fsDenied) {
      out.push({
        kind: "filesystem",
        tier,
        target: fsDenied[1] ?? "unknown",
        nativeDetail: line,
      });
      continue;
    }
    out.push({ kind: "exec", tier, target: "unknown", nativeDetail: line });
  }
  return out;
}

/** Resolve a path against cwd and reject escapes (workspace jail for fs verbs). */
function jail(cwd: string, p: string): string {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `[sandbox] filesystem blocked by policy: ${p} is outside the workspace`,
    );
  }
  return resolved;
}

async function writeFileCreatingParents(
  resolved: string,
  content: string | Uint8Array,
): Promise<void> {
  try {
    await fs.writeFile(resolved, content);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content);
      return;
    }
    throw cause;
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Spawn a resolved argv in its own process group; kill the tree on abort or
 * when `capture` crosses the output cap (the two share one SIGTERM→SIGKILL
 * escalation).
 */
function spawnSandboxed(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal | undefined,
  capture: BoundedCapture,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ stdout: "", stderr: "srt: empty argv", exitCode: 1 });
      return;
    }
    const child = spawn(command, args, {
      env,
      // Set the process cwd explicitly: macOS seatbelt does not chdir, so
      // without this the sandboxed shell inherits flue-acp's cwd. On Linux
      // bwrap re-chdirs via --chdir; setting it here is harmless.
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killTree = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const killWithGrace = (): void => {
      if (killTimer !== undefined) return; // already escalating
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const onAbort = killWithGrace;
    capture.onExceed = killWithGrace;
    const settle = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => capture.append("stdout", chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => capture.append("stderr", chunk));
    child.once("error", (err) => {
      killTree("SIGTERM");
      settle({
        stdout: capture.stdout,
        stderr: capture.stderr || String(err.message ?? err),
        exitCode: 1,
      });
    });
    child.once("close", (code) => {
      if (capture.exceeded) {
        settle(capture.killedResult());
        return;
      }
      settle({
        stdout: capture.stdout,
        stderr: capture.stderr,
        exitCode: code ?? (signal?.aborted ? 124 : 1),
      });
    });
  });
}

function createSrtSessionEnv(policy: SrtPolicy, options: TierFactoryOptions): SessionEnv {
  const cwd = path.resolve(policy.cwd);
  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

  return {
    async exec(command, opts): Promise<ShellResult> {
      const signal = opts?.signal;
      if (signal?.aborted) throw abortError();
      await ensureManager(policy);
      const commandId = randomUUID();
      const execCwd = opts?.cwd ? resolvePath(opts.cwd) : cwd;
      const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
        command,
        "bash",
        undefined,
        signal,
        execCwd,
        { commandId },
      );
      // Scrub to the Ring 2 allowlist + seed (BUZZ_*) + srt's proxy vars;
      // per-exec env layers on top. Host secrets never reach the sandbox.
      const mergedEnv = buildSandboxEnv(options.env, env, opts?.env);

      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const controller = new AbortController();
      const onOuterAbort = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs);
        timer.unref();
      }

      const capture = createBoundedCapture();
      let result: ShellResult;
      try {
        result = await spawnSandboxed(argv, mergedEnv, execCwd, controller.signal, capture);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }

      // Caller abort (not timeout) rejects promptly, per the SessionEnv contract.
      if (signal?.aborted && !timedOut) throw abortError();

      if (capture.exceeded) {
        // Audit-only: the model-visible rendering is the marker
        // killedResult() already put on stderr; a second [sandbox] line
        // there would be noise.
        options.onViolation?.({
          kind: "resource",
          tier: srtTier.name,
          target: "exec-output",
          nativeDetail: `output exceeded ${capture.maxBytes} bytes; process tree killed`,
        });
      }

      const violations = normalizeViolations(
        SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId),
        srtTier.name,
      );
      for (const violation of violations) options.onViolation?.(violation);
      if (violations.length > 0) {
        // Invariant 3: append OUR normalized rendering to the model-visible
        // result — never srt's native text.
        const rendered = violations
          .map((v) => `[sandbox] ${v.kind} blocked by policy: ${v.target}`)
          .join("\n");
        result = {
          ...result,
          stderr: result.stderr ? `${result.stderr}\n${rendered}` : rendered,
        };
      }
      return result;
    },
    async readFile(p) {
      return fs.readFile(jail(cwd, p), "utf8");
    },
    async readFileBuffer(p) {
      const buf = await fs.readFile(jail(cwd, p));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async writeFile(p, content) {
      await writeFileCreatingParents(jail(cwd, p), content);
    },
    async stat(p): Promise<FileStat> {
      const resolved = jail(cwd, p);
      const l = await fs.lstat(resolved);
      const s = l.isSymbolicLink() ? await fs.stat(resolved) : l;
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: l.isSymbolicLink(),
        size: s.size,
        mtime: s.mtime,
      };
    },
    async readdir(p) {
      return fs.readdir(jail(cwd, p));
    },
    async exists(p) {
      try {
        await fs.access(jail(cwd, p));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(p, opts) {
      await fs.mkdir(jail(cwd, p), opts);
    },
    async rm(p, opts) {
      await fs.rm(jail(cwd, p), opts);
    },
    cwd,
    resolvePath,
  };
}

export const srtTier: SandboxTier = {
  name: "srt",
  capabilities: ["native", "git", "egress-allowlist"],
  createFactory(options: TierFactoryOptions) {
    const policy: SrtPolicy = {
      cwd: path.resolve(options.cwd),
      allowedDomains: resolveEgress(
        options.egress ?? DEFAULT_EGRESS,
        process.env["BUZZ_RELAY_URL"],
      ),
    };
    const createSandbox = (): Promise<SessionEnv> => {
      // Kick off (or reuse) manager init up front; exec awaits it too.
      // ensureManager currently returns the pre-handled chain link, but
      // catch here anyway so a future async-wrapper refactor can't turn a
      // failed warmup into an unhandledRejection crash (the docker tier hit
      // exactly that).
      ensureManager(policy).catch(() => {});
      return Promise.resolve(createSrtSessionEnv(policy, options));
    };
    // Provide both names: `createSandbox` is Flue 2.0.3's method; the
    // deprecated `createSessionEnv` alias keeps the factory runnable on a
    // 2.0.1 runtime too.
    return { createSandbox, createSessionEnv: createSandbox };
  },
};

/** Test-only: drop the srt manager so a fresh policy re-initializes. */
export async function resetSrtForTests(): Promise<void> {
  await initChain.idle();
  initChain.clearFailures();
  if (current !== undefined) {
    await SandboxManager.reset();
    current = undefined;
  }
}
