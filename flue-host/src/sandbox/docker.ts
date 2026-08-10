import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileStat, SessionEnv, ShellResult } from "@flue/runtime";
import { log } from "../log.js";
import { DEFAULT_EGRESS, resolveEgress } from "./egress.js";
import type { SandboxTier, SandboxViolation, TierFactoryOptions } from "./types.js";

/**
 * The `docker` heavy tier (M3): each agent runs its tool execs inside a
 * long-lived Docker container — a stronger, cleaner isolation boundary than
 * per-exec bwrap (namespaces + cgroups + a curated image, no host filesystem
 * exposed beyond the projected workspace). Egress is the audited
 * "Docker + srt-proxy" model, validated on gradient (docs/heavy-tier-audit.md):
 *
 *   - the container sits on a Docker `--internal` network → NO direct egress
 *     (deny-by-default; nothing to bypass, there is no route);
 *   - a dual-homed allowlisting proxy (our egress vocab → tinyproxy filter) is
 *     the ONLY door; the container's http(s)_proxy/ALL_PROXY point at it, so
 *     `buzz` (reqwest), curl, and git-https reach allowlisted hosts and
 *     everything else fails closed.
 *
 * The workspace is bind-mounted at the same path the host uses (so fs verbs
 * and container execs agree on paths), the container runs as the host UID
 * (files stay host-owned — the M2 projection lesson), and the `buzz` binary
 * is bind-mounted in read-only.
 *
 * Like srt, the process-global resources (network, proxy, container) are
 * keyed on a policy signature and created once — production runs one agent
 * per process, so this is one container per agent. Conformance drives several
 * policies per process; each distinct signature gets its own set.
 */

interface DockerPolicy {
  cwd: string;
  allowedDomains: string[];
  image: string;
  seedEnv: Record<string, string>;
}

const KILL_GRACE_MS = 2_000;
const DEFAULT_IMAGE = "buzz-heavy-base:latest";
/** Host path of the buzz CLI to project into the container (read-only). */
const BUZZ_BIN = process.env["BUZZ_HEAVY_CLI_PATH"] ?? "/usr/local/bin/buzz";

function policySignature(policy: DockerPolicy): string {
  return JSON.stringify([policy.cwd, [...policy.allowedDomains].sort(), policy.image]);
}

/** Short stable id for resource names from a policy signature. */
function shortId(policy: DockerPolicy): string {
  return createHash("sha256").update(policySignature(policy)).digest("hex").slice(0, 10);
}

interface DockerResources {
  network: string;
  proxy: string;
  container: string;
}

/** Run a docker command, capturing output; never throws (returns the failure). */
function docker(args: string[], input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", (e) => resolve({ ok: false, stdout, stderr: String(e.message ?? e) }));
    child.once("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** tinyproxy config: default-deny + one allow regex per allowlisted host. */
function proxyConfig(allowedDomains: string[]): string {
  const lines = ["Port 8888", "Listen 0.0.0.0", "Timeout 60", "Allow 0.0.0.0/0"];
  if (allowedDomains.length > 0) {
    lines.push('FilterDefaultDeny Yes', 'Filter "/etc/tp-filter"', "FilterExtended On");
  }
  return `${lines.join("\n")}\n`;
}

/** Anchored regexes matching exactly the allowlisted hosts (host:port → host). */
function proxyFilter(allowedDomains: string[]): string {
  const hosts = allowedDomains.map((d) => d.split(":")[0]).filter((h): h is string => !!h);
  return `${hosts.map((h) => `^${h.replace(/\./g, "\\.")}$`).join("\n")}\n`;
}

/**
 * Serialize creation/teardown of the process-global Docker resources per
 * policy signature. In production this runs once (single agent policy).
 */
const resourcesBySig = new Map<string, DockerResources>();
let pending: Promise<void> = Promise.resolve();

async function ensureResources(policy: DockerPolicy): Promise<DockerResources> {
  const sig = policySignature(policy);
  pending = pending.then(async () => {
    if (resourcesBySig.has(sig)) return;
    const id = shortId(policy);
    const network = `buzz-heavy-net-${id}`;
    const proxy = `buzz-heavy-proxy-${id}`;
    const container = `buzz-heavy-${id}`;

    // Internal egress network — no route to the outside.
    await docker(["network", "create", "--internal", network]);

    // Allowlisting proxy: on the internal net, then also connected to bridge
    // for real egress. tinyproxy from alpine, config baked writable.
    await docker(["rm", "-f", proxy]);
    const proxyScript = [
      "apk add -q tinyproxy 2>/dev/null",
      `printf '%s' ${shellQuote(proxyConfig(policy.allowedDomains))} > /etc/tp.conf`,
      `printf '%s' ${shellQuote(proxyFilter(policy.allowedDomains))} > /etc/tp-filter`,
      "exec tinyproxy -d -c /etc/tp.conf",
    ].join("\n");
    const proxyRun = await docker([
      "run", "-d", "--name", proxy, "--network", network,
      "alpine:latest", "sh", "-c", proxyScript,
    ]);
    if (!proxyRun.ok) throw new Error(`docker heavy: proxy start failed: ${proxyRun.stderr.trim()}`);
    await docker(["network", "connect", "bridge", proxy]);
    // The proxy runs `apk add tinyproxy` before listening — wait for the port
    // to answer (busybox wget exit 4 = connection refused) or fail loudly, so
    // the first agent exec never races an unready proxy.
    await waitForProxy(proxy);

    // The agent container: internal net only (egress via proxy), host UID,
    // workspace + buzz CLI bind-mounted, proxy env set. Idle on `sleep`.
    await docker(["rm", "-f", container]);
    const proxyUrl = `http://${proxy}:8888`;
    const envArgs: string[] = [];
    const fullEnv: Record<string, string> = {
      ...policy.seedEnv,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      // Never proxy loopback (in-container tools that talk to themselves).
      no_proxy: "localhost,127.0.0.1",
    };
    for (const [k, v] of Object.entries(fullEnv)) envArgs.push("-e", `${k}=${v}`);
    const mounts = [
      "-v", `${policy.cwd}:${policy.cwd}`,
      "-v", `${BUZZ_BIN}:/usr/local/bin/buzz:ro`,
    ];
    const run = await docker([
      "run", "-d", "--name", container,
      "--network", network,
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-w", policy.cwd,
      ...mounts, ...envArgs,
      "--entrypoint", "sleep", policy.image, "infinity",
    ]);
    if (!run.ok) throw new Error(`docker heavy: container start failed: ${run.stderr.trim()}`);

    resourcesBySig.set(sig, { network, proxy, container });
    log.info("docker heavy sandbox initialized", {
      container, allowedDomains: policy.allowedDomains, image: policy.image,
    });
  });
  await pending;
  const res = resourcesBySig.get(sig);
  if (!res) throw new Error("docker heavy: resources missing after init");
  return res;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until tinyproxy is actually LISTENING on 8888 inside the proxy
 * container (busybox `netstat`). A port check is reliable where a wget probe
 * is not — busybox wget's exit code on connection-refused is indistinguishable
 * from other errors, so it false-positives before the proxy is up. If the
 * config is bad tinyproxy never listens and this throws with its logs.
 */
async function waitForProxy(proxy: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probe = "netstat -ltn 2>/dev/null | grep -q ':8888 ' || netstat -ltn 2>/dev/null | grep -q ':8888$'";
  for (;;) {
    const r = await docker(["exec", proxy, "sh", "-c", probe]);
    if (r.ok) return;
    if (Date.now() > deadline) {
      const logs = await docker(["logs", "--tail", "8", proxy]);
      throw new Error(
        `docker heavy: proxy not listening on 8888 in ${timeoutMs}ms: ${logs.stderr.trim() || logs.stdout.trim()}`,
      );
    }
    await sleep(500);
  }
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** `docker exec` a command in the session container; kill on abort/timeout. */
function dockerExec(
  container: string,
  command: string,
  env: Record<string, string> | undefined,
  execCwd: string,
  signal: AbortSignal | undefined,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const args = ["exec", "-w", execCwd];
    if (env) for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push(container, "bash", "-lc", command);
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    };
    const onAbort = (): void => {
      // Kill the docker-exec client and best-effort the in-container process.
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const settle = (r: ShellResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", (e) => settle({ stdout, stderr: stderr || String(e.message ?? e), exitCode: 1 }));
    child.once("close", (code) => settle({ stdout, stderr, exitCode: code ?? (signal?.aborted ? 124 : 1) }));
  });
}

/** Read recent proxy denials as normalized egress violations for this window. */
async function collectEgressViolations(
  proxy: string,
  since: string,
  tier: string,
): Promise<SandboxViolation[]> {
  const logs = await docker(["logs", "--since", since, proxy]);
  const out: SandboxViolation[] = [];
  const seen = new Set<string>();
  // tinyproxy denial: "Filtered connection ('host')." / "Connection to host:port denied".
  const re = /(?:Filtered connection|denied|Access violation)[^'"\n]*['"]?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?::\d+)?)/gi;
  for (const line of `${logs.stdout}\n${logs.stderr}`.split("\n")) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const target = m[1];
      if (target && !seen.has(target)) {
        seen.add(target);
        out.push({ kind: "egress", tier, target, nativeDetail: line.trim() });
      }
    }
  }
  return out;
}

function jail(cwd: string, p: string): string {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`[sandbox] filesystem blocked by policy: ${p} is outside the workspace`);
  }
  return resolved;
}

async function writeCreatingParents(resolved: string, content: string | Uint8Array): Promise<void> {
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

function createDockerSessionEnv(policy: DockerPolicy, options: TierFactoryOptions): SessionEnv {
  const cwd = path.resolve(policy.cwd);
  const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

  return {
    async exec(command, opts): Promise<ShellResult> {
      const signal = opts?.signal;
      if (signal?.aborted) throw abortError();
      const { container, proxy } = await ensureResources(policy);
      const execCwd = opts?.cwd ? resolvePath(opts.cwd) : cwd;
      const startedAtIso = new Date(Date.now() - 1000).toISOString();

      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      const controller = new AbortController();
      const onOuter = (): void => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onOuter, { once: true });
      }
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs);
        timer.unref();
      }

      let result: ShellResult;
      try {
        result = await dockerExec(container, command, opts?.env, execCwd, controller.signal);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onOuter);
      }
      if (signal?.aborted && !timedOut) throw abortError();

      const violations = await collectEgressViolations(proxy, startedAtIso, dockerTier.name);
      for (const v of violations) options.onViolation?.(v);
      if (violations.length > 0) {
        const rendered = violations
          .map((v) => `[sandbox] ${v.kind} blocked by policy: ${v.target}`)
          .join("\n");
        result = { ...result, stderr: result.stderr ? `${result.stderr}\n${rendered}` : rendered };
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
      await writeCreatingParents(jail(cwd, p), content);
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

export const dockerTier: SandboxTier = {
  name: "docker",
  capabilities: ["native", "git", "egress-allowlist", "fs-projection"],
  createFactory(options: TierFactoryOptions) {
    const policy: DockerPolicy = {
      cwd: path.resolve(options.cwd),
      allowedDomains: resolveEgress(options.egress ?? DEFAULT_EGRESS, process.env["BUZZ_RELAY_URL"]),
      image: process.env["BUZZ_FLUE_DOCKER_IMAGE"] ?? DEFAULT_IMAGE,
      seedEnv: options.env,
    };
    const create = (): Promise<SessionEnv> => {
      void ensureResources(policy);
      return Promise.resolve(createDockerSessionEnv(policy, options));
    };
    return { createSandbox: create, createSessionEnv: create };
  },
};

/** Test-only: tear down all heavy-tier Docker resources this process created. */
export async function resetDockerForTests(): Promise<void> {
  await pending.catch(() => {});
  for (const res of resourcesBySig.values()) {
    await docker(["rm", "-f", res.container]);
    await docker(["rm", "-f", res.proxy]);
    await docker(["network", "rm", res.network]);
  }
  resourcesBySig.clear();
}
