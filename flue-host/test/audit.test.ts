import type { SessionEnv } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { type AuditLine, auditingTier, onAuditLine } from "../src/sandbox/audit.js";
import type { SandboxTier, SandboxViolation } from "../src/sandbox/types.js";

/**
 * Audit-wrapper unit tests (M0.5) against a fake tier that raises
 * violations mid-exec — the correlation path the srt adapter (M1) relies
 * on. The local tier never violates, so this is where the wiring is pinned.
 */

function fakeTier(raise: (violation: SandboxViolation) => void = () => {}): SandboxTier {
  let onViolation: ((violation: SandboxViolation) => void) | undefined;
  const env: SessionEnv = {
    async exec(command) {
      if (command.includes("violate")) {
        onViolation?.({ kind: "egress", tier: "fake", target: command.split(" ")[1] ?? "?" });
        return { stdout: "", stderr: "", exitCode: 7 };
      }
      if (command.includes("explode")) throw new Error("spawn failed");
      if (command.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 50));
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    readFile: () => Promise.reject(new Error("unused")),
    readFileBuffer: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.resolve(),
    stat: () => Promise.reject(new Error("unused")),
    readdir: () => Promise.resolve([]),
    exists: () => Promise.resolve(false),
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    cwd: "/fake",
    resolvePath: (p) => (p.startsWith("/") ? p : `/fake/${p}`),
  };
  return {
    name: "fake",
    capabilities: [],
    createFactory(options) {
      onViolation = (violation) => {
        options.onViolation?.(violation);
        raise(violation);
      };
      return { createSessionEnv: () => Promise.resolve(env) };
    },
  };
}

async function withAudit<T>(run: (lines: AuditLine[]) => Promise<T>): Promise<AuditLine[]> {
  const lines: AuditLine[] = [];
  const unsubscribe = onAuditLine((line) => lines.push(line));
  try {
    await run(lines);
  } finally {
    unsubscribe();
  }
  return lines;
}

describe("auditingTier", () => {
  it("emits one versioned line per exec with argv0 + sha256, never the command", async () => {
    const tier = auditingTier(fakeTier());
    const env = await tier.createFactory({ cwd: "/fake", env: {} }).createSessionEnv({ id: "a" });
    const lines = await withAudit(async () => {
      await env.exec("git status --short");
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, tier: "fake", argv0: "git", exit: 0, cwd: "/fake" });
    expect(lines[0]?.cmd_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(lines[0])).not.toContain("--short");
  });

  it("attaches mid-exec violations to that exec's line and still chains the caller's observer", async () => {
    const observed: SandboxViolation[] = [];
    const tier = auditingTier(fakeTier());
    const env = await tier
      .createFactory({ cwd: "/fake", env: {}, onViolation: (violation) => observed.push(violation) })
      .createSessionEnv({ id: "b" });
    const lines = await withAudit(async () => {
      await env.exec("violate example.com");
    });
    expect(lines[0]?.exit).toBe(7);
    expect(lines[0]?.violations).toEqual([
      { kind: "egress", tier: "fake", target: "example.com" },
    ]);
    expect(observed).toHaveLength(1);
  });

  it("keeps concurrent execs' violations separate (AsyncLocalStorage isolation)", async () => {
    const tier = auditingTier(fakeTier());
    const env = await tier.createFactory({ cwd: "/fake", env: {} }).createSessionEnv({ id: "c" });
    const lines = await withAudit(async () => {
      await Promise.all([env.exec("slow"), env.exec("violate a.example"), env.exec("violate b.example")]);
    });
    const byTarget = (target: string): AuditLine | undefined =>
      lines.find((line) => line.violations.some((violation) => violation.target === target));
    expect(lines).toHaveLength(3);
    expect(byTarget("a.example")?.violations).toHaveLength(1);
    expect(byTarget("b.example")?.violations).toHaveLength(1);
    expect(lines.find((line) => line.argv0 === "slow")?.violations).toEqual([]);
  });

  it("logs exit null on a rejected exec and rethrows", async () => {
    const tier = auditingTier(fakeTier());
    const env = await tier.createFactory({ cwd: "/fake", env: {} }).createSessionEnv({ id: "d" });
    const lines = await withAudit(async () => {
      await expect(env.exec("explode")).rejects.toThrow("spawn failed");
    });
    expect(lines[0]).toMatchObject({ argv0: "explode", exit: null });
  });
});
