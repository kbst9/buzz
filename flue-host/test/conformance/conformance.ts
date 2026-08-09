import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SessionEnv } from "@flue/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFlueEngine } from "../../src/engine/flue.js";
import type { AgentEngine } from "../../src/engine/types.js";
import { type AuditLine, onAuditLine } from "../../src/sandbox/audit.js";
import {
  renderSandboxViolation,
  type SandboxTier,
  type SandboxViolation,
  type TierCapability,
} from "../../src/sandbox/types.js";
import { TestClient } from "../helpers.js";
import { CONTRACT_DRIFT_CANARY } from "./contract-drift.js";

/**
 * Tier-conformance suite (AGENT_OS_M0.md § M0.2): the one parameterized
 * suite every sandbox tier must pass. A tier's registration file imports its
 * {@link SandboxTier} and calls `describeSandboxConformance(tier)` — that is
 * the whole cost of adding a tier to the gate.
 *
 * Hermeticity rules (enforced by construction here, do not regress):
 * loopback only; ephemeral ports (`listen(0)`) per fixture; git isolated via
 * `GIT_CONFIG_GLOBAL=/dev/null` + explicit `-c user.name/email`; every stage
 * works in its own `mkdtemp` workspace; no dependence on host state beyond
 * POSIX userland (`/bin/ls`, `git` on PATH); parallel-safe under vitest's
 * per-file process isolation.
 *
 * Capability gating: stages marked with a capability run only for tiers
 * declaring it. The `local` baseline must pass everything except
 * `egress-allowlist` — the only sanctioned skip (M0.2 done-means).
 */

/** Slack multiplier for prompt-settlement bounds: generous, never load-bearing. */
const SETTLE_MS = 5_000;

interface Stage {
  workspace: string;
  /** `realpath`ed workspace — what `pwd` prints on hosts where tmp is a symlink (macOS /var → /private/var). */
  realWorkspace: string;
  env: SessionEnv;
}

async function openStage(
  tier: SandboxTier,
  seedEnv: Record<string, string>,
  options: { egress?: readonly string[]; onViolation?: (v: SandboxViolation) => void } = {},
): Promise<Stage> {
  const workspace = await mkdtemp(join(tmpdir(), `conformance-${tier.name}-`));
  const factory = tier.createFactory({
    cwd: workspace,
    env: seedEnv,
    ...(options.egress ? { egress: options.egress } : {}),
    ...(options.onViolation ? { onViolation: options.onViolation } : {}),
  });
  const env = await factory.createSessionEnv({ id: `conformance-${tier.name}` });
  return { workspace, realWorkspace: await realpath(workspace), env };
}

async function closeStage(stage: Stage | undefined): Promise<void> {
  if (stage) await rm(stage.workspace, { recursive: true, force: true });
}

export function describeSandboxConformance(tier: SandboxTier): void {
  const has = (capability: TierCapability): boolean => tier.capabilities.includes(capability);

  describe(`sandbox conformance [${tier.name}] (${CONTRACT_DRIFT_CANARY})`, () => {
    // ── Exec semantics ─────────────────────────────────────────────────────
    describe("exec semantics", () => {
      let stage: Stage;

      beforeAll(async () => {
        stage = await openStage(tier, { CONF_SEED: "seed-value" });
      });
      afterAll(async () => closeStage(stage));

      it("reports exit codes faithfully", async () => {
        expect((await stage.env.exec("exit 0")).exitCode).toBe(0);
        expect((await stage.env.exec("exit 7")).exitCode).toBe(7);
      });

      it("captures stdout and stderr separately", async () => {
        const result = await stage.env.exec('printf out; printf err 1>&2');
        expect(result.stdout).toBe("out");
        expect(result.stderr).toBe("err");
        expect(result.exitCode).toBe(0);
      });

      it("roots the working directory at the session cwd", async () => {
        const result = await stage.env.exec("pwd");
        expect(result.stdout.trim()).toBe(stage.realWorkspace);
      });

      it("resolves a relative per-exec cwd against the session cwd", async () => {
        await stage.env.mkdir("sub");
        const relative = await stage.env.exec("pwd", { cwd: "sub" });
        expect(relative.stdout.trim()).toBe(join(stage.realWorkspace, "sub"));
        const absolute = await stage.env.exec("pwd", { cwd: join(stage.workspace, "sub") });
        expect(absolute.stdout.trim()).toBe(join(stage.realWorkspace, "sub"));
      });

      it("injects the seeded env and layers per-exec env on top", async () => {
        const seeded = await stage.env.exec('printf "%s" "$CONF_SEED"');
        expect(seeded.stdout).toBe("seed-value");
        const layered = await stage.env.exec('printf "%s/%s" "$CONF_SEED" "$CONF_CALL"', {
          env: { CONF_CALL: "call-value" },
        });
        expect(layered.stdout).toBe("seed-value/call-value");
      });

      it("enforces timeoutMs as a durable abort: prompt settlement, nonzero exit", async () => {
        const started = Date.now();
        const result = await stage.env
          .exec("sleep 30", { timeoutMs: 300 })
          .catch((cause: unknown) => cause as Error);
        expect(Date.now() - started).toBeLessThan(SETTLE_MS);
        if (result instanceof Error) {
          expect(result.name).toMatch(/abort/i);
        } else {
          expect(result.exitCode).not.toBe(0);
        }
        // The env survives the abort: the next exec works.
        expect((await stage.env.exec('printf alive')).stdout).toBe("alive");
      });

      it("rejects promptly on caller abort and stays usable (durable abort)", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const started = Date.now();
        await expect(
          stage.env.exec("sleep 30", { signal: controller.signal }),
        ).rejects.toMatchObject({ name: expect.stringMatching(/abort/i) as unknown as string });
        expect(Date.now() - started).toBeLessThan(SETTLE_MS);
        expect((await stage.env.exec('printf alive')).stdout).toBe("alive");
      });
    });

    // ── Secret canary ──────────────────────────────────────────────────────
    describe("secret canary", () => {
      const secret = `canary-${randomBytes(16).toString("hex")}`;
      let stage: Stage;

      beforeAll(async () => {
        // Planted in the HOST process env before the factory is built — the
        // most adversarial ordering for tiers that snapshot at construction.
        process.env["CANARY_HOST_SECRET"] = secret;
        stage = await openStage(tier, { CONF_SEED: "canary-stage" });
      });
      afterAll(async () => {
        delete process.env["CANARY_HOST_SECRET"];
        await closeStage(stage);
      });

      it("is invisible to shell expansion in the sandbox", async () => {
        const result = await stage.env.exec('printf "%s" "${CANARY_HOST_SECRET:-ABSENT}"');
        expect(result.stdout).toBe("ABSENT");
      });

      it("is invisible to printenv in the sandbox", async () => {
        const result = await stage.env.exec("printenv CANARY_HOST_SECRET");
        expect(result.stdout.trim()).toBe("");
        expect(result.exitCode).not.toBe(0);
      });

      it("is absent from the sandboxed process's own environ via FS probe", async () => {
        // Linux: /proc/self/environ is the sandboxed shell's environment;
        // macOS has no procfs and the probe degrades to empty output. Either
        // way the secret value must not appear.
        const result = await stage.env.exec(
          'cat /proc/self/environ 2>/dev/null | tr "\\0" "\\n"; true',
        );
        expect(result.stdout).not.toContain(secret);
      });
    });

    // ── FS verbs: the full SessionEnv surface ──────────────────────────────
    describe("fs verbs", () => {
      let stage: Stage;

      beforeAll(async () => {
        stage = await openStage(tier, {});
      });
      afterAll(async () => closeStage(stage));

      it("exposes the session cwd and resolves paths against it", () => {
        expect(stage.env.cwd).toBe(stage.workspace);
        expect(stage.env.resolvePath("rel/file.txt")).toBe(join(stage.workspace, "rel/file.txt"));
        expect(stage.env.resolvePath("/abs/file.txt")).toBe("/abs/file.txt");
      });

      it("round-trips a UTF-8 file through writeFile/readFile", async () => {
        await stage.env.writeFile("note.txt", "hello sandbox\n");
        expect(await stage.env.readFile("note.txt")).toBe("hello sandbox\n");
        expect(await stage.env.readFile(join(stage.workspace, "note.txt"))).toBe("hello sandbox\n");
      });

      it("round-trips binary content through writeFile/readFileBuffer", async () => {
        const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x42]);
        await stage.env.writeFile("blob.bin", bytes);
        expect(Array.from(await stage.env.readFileBuffer("blob.bin"))).toEqual(Array.from(bytes));
      });

      it("writeFile creates missing parent directories (the FlueFs guarantee)", async () => {
        await stage.env.writeFile("deep/nested/dir/file.txt", "created");
        expect(await stage.env.readFile("deep/nested/dir/file.txt")).toBe("created");
        expect((await stage.env.stat("deep/nested/dir")).isDirectory).toBe(true);
      });

      it("stat reports files and directories; missing paths reject", async () => {
        await stage.env.writeFile("stat-me.txt", "x");
        const file = await stage.env.stat("stat-me.txt");
        expect(file.isFile).toBe(true);
        expect(file.isDirectory).toBe(false);
        const dir = await stage.env.stat(".");
        expect(dir.isDirectory).toBe(true);
        await expect(stage.env.stat("no-such-path")).rejects.toThrow();
      });

      it("exists answers without throwing, true and false", async () => {
        await stage.env.writeFile("exists.txt", "x");
        expect(await stage.env.exists("exists.txt")).toBe(true);
        expect(await stage.env.exists("missing.txt")).toBe(false);
      });

      it("mkdir creates directories, recursively on request", async () => {
        await stage.env.mkdir("plain-dir");
        expect((await stage.env.stat("plain-dir")).isDirectory).toBe(true);
        await stage.env.mkdir("a/b/c", { recursive: true });
        expect((await stage.env.stat("a/b/c")).isDirectory).toBe(true);
      });

      it("readdir lists entry names", async () => {
        await stage.env.mkdir("listing");
        await stage.env.writeFile("listing/one.txt", "1");
        await stage.env.writeFile("listing/two.txt", "2");
        expect((await stage.env.readdir("listing")).sort()).toEqual(["one.txt", "two.txt"]);
      });

      it("rm removes files and trees; force suppresses missing-path errors", async () => {
        await stage.env.writeFile("rm-file.txt", "x");
        await stage.env.rm("rm-file.txt");
        expect(await stage.env.exists("rm-file.txt")).toBe(false);
        await stage.env.writeFile("rm-tree/inner/file.txt", "x");
        await stage.env.rm("rm-tree", { recursive: true });
        expect(await stage.env.exists("rm-tree")).toBe(false);
        await stage.env.rm("never-existed", { force: true });
        await expect(stage.env.rm("never-existed")).rejects.toThrow();
      });

      it("readFile of a missing path rejects", async () => {
        await expect(stage.env.readFile("missing-read.txt")).rejects.toThrow();
      });
    });

    // ── Native binaries + git (capabilities: native, git) ──────────────────
    describe.skipIf(!has("native"))("native execution [capability: native]", () => {
      let stage: Stage;
      beforeAll(async () => {
        stage = await openStage(tier, {});
      });
      afterAll(async () => closeStage(stage));

      it("executes a real compiled binary from disk", async () => {
        // /bin/ls is a real ELF (Linux) / Mach-O (macOS) binary everywhere
        // this suite runs — not a shell builtin, not a WASM shim.
        const result = await stage.env.exec("/bin/ls -d /");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("/");
      });
    });

    describe.skipIf(!has("git"))("git round-trip [capability: git]", () => {
      let stage: Stage;
      beforeAll(async () => {
        stage = await openStage(tier, {});
      });
      afterAll(async () => closeStage(stage));

      it("init → commit → log works inside the workspace, hermetically", async () => {
        const script = [
          "set -e",
          "git init -q repo",
          "cd repo",
          'printf "content-v1\\n" > tracked.txt',
          "git add tracked.txt",
          'git -c user.name=Conformance -c user.email=conformance@buzz.invalid commit -q -m seed-commit',
          "git log --format=%s",
          "git show HEAD:tracked.txt",
        ].join(" && ");
        const result = await stage.env.exec(script, {
          // Hermetic git: no host global/system config may leak in.
          env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        });
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("seed-commit");
        expect(result.stdout).toContain("content-v1");
      });
    });

    // ── Egress allowlist (capability: egress-allowlist) ────────────────────
    // The ONLY stage the local baseline may skip (M0.2 done-means).
    describe.skipIf(!has("egress-allowlist"))("egress allowlist [capability: egress-allowlist]", () => {
      let stage: Stage;
      let allowedServer: Server;
      let deniedServer: Server;
      let allowedPort: number;
      let deniedPort: number;
      const violations: SandboxViolation[] = [];

      const listen = (server: Server): Promise<number> =>
        new Promise((resolve, reject) => {
          server.once("error", reject);
          // Loopback + ephemeral port per the hermeticity rules.
          server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
        });

      beforeAll(async () => {
        allowedServer = createServer((_req, res) => res.end("pong-allowed"));
        deniedServer = createServer((_req, res) => res.end("pong-denied"));
        allowedPort = await listen(allowedServer);
        deniedPort = await listen(deniedServer);
        const workspace = await mkdtemp(join(tmpdir(), `conformance-${tier.name}-egress-`));
        const factory = tier.createFactory({
          cwd: workspace,
          env: {},
          egress: [`127.0.0.1:${allowedPort}`],
          onViolation: (violation) => violations.push(violation),
        });
        stage = {
          workspace,
          realWorkspace: await realpath(workspace),
          env: await factory.createSessionEnv({ id: `conformance-${tier.name}-egress` }),
        };
      });

      afterAll(async () => {
        allowedServer?.close();
        deniedServer?.close();
        await closeStage(stage);
      });

      it("reaches the allowlisted target", async () => {
        const result = await stage.env.exec(
          `curl -fsS --max-time 5 http://127.0.0.1:${allowedPort}/ping`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("pong-allowed");
      });

      it("blocks a non-allowlisted local listener and surfaces the NORMALIZED violation", async () => {
        const result = await stage.env.exec(
          `curl -fsS --max-time 5 http://127.0.0.1:${deniedPort}/ping`,
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).not.toContain("pong-denied");
        // Invariant 3: the tool result carries OUR rendered form — asserted
        // against our shape, never a tier's native text.
        const rendered = renderSandboxViolation({
          kind: "egress",
          tier: tier.name,
          target: `127.0.0.1:${deniedPort}`,
        });
        expect(`${result.stdout}\n${result.stderr}`).toContain(rendered);
        expect(violations).toContainEqual(
          expect.objectContaining({ kind: "egress", tier: tier.name }),
        );
      });

      it("blocks an external name without touching DNS and surfaces the violation", async () => {
        // .invalid is reserved (RFC 2606): if policy did NOT fire first, the
        // failure would be a DNS error with no normalized violation line —
        // which is exactly what this asserts against.
        const result = await stage.env.exec(
          "curl -fsS --max-time 5 http://egress-denied.invalid/ping",
        );
        expect(result.exitCode).not.toBe(0);
        const rendered = renderSandboxViolation({
          kind: "egress",
          tier: tier.name,
          target: "egress-denied.invalid",
        });
        expect(`${result.stdout}\n${result.stderr}`).toContain(rendered);
        expect(
          violations.some((violation) => violation.target.includes("egress-denied.invalid")),
        ).toBe(true);
      });
    });

    // ── Golden transcript in this tier ─────────────────────────────────────
    // The existing golden ACP flow re-run with the tier selected the way
    // production selects it: BUZZ_FLUE_SANDBOX through the registry.
    describe("golden transcript in this tier", () => {
      const faux = fauxProvider({ provider: "faux", models: [{ id: "conformance" }] });
      let workspace: string;
      let engine: AgentEngine;
      let client: TestClient;
      let priorTier: string | undefined;
      let priorModel: string | undefined;
      let sessionId: string;

      beforeAll(async () => {
        priorTier = process.env["BUZZ_FLUE_SANDBOX"];
        priorModel = process.env["BUZZ_FLUE_MODEL"];
        process.env["BUZZ_FLUE_SANDBOX"] = tier.name;
        process.env["BUZZ_FLUE_MODEL"] = "faux/conformance";
        workspace = await mkdtemp(join(tmpdir(), `conformance-${tier.name}-golden-`));
        engine = await createFlueEngine({
          model: "faux/conformance",
          providers: [faux.provider],
        });
        client = new TestClient(engine, { version: "conformance" });
      });

      afterAll(async () => {
        client.close();
        await client.done;
        await engine.stop();
        if (priorTier === undefined) delete process.env["BUZZ_FLUE_SANDBOX"];
        else process.env["BUZZ_FLUE_SANDBOX"] = priorTier;
        if (priorModel === undefined) delete process.env["BUZZ_FLUE_MODEL"];
        else process.env["BUZZ_FLUE_MODEL"] = priorModel;
        await rm(workspace, { recursive: true, force: true });
      });

      it("plays one full turn with a real exec in this tier", async () => {
        const auditLines: AuditLine[] = [];
        const unsubscribe = onAuditLine((line) => auditLines.push(line));
        const initId = client.request("initialize", {
          protocolVersion: 2,
          clientCapabilities: {},
          clientInfo: { name: "buzz-acp", version: "conformance" },
        });
        expect((await client.response(initId))["result"]).toMatchObject({ protocolVersion: 2 });

        const newId = client.request("session/new", {
          cwd: workspace,
          systemPrompt: "[System]\nYou are the conformance agent.",
          mcpServers: [
            {
              name: "buzz-dev-mcp",
              command: "/usr/local/bin/buzz-dev-mcp",
              args: [],
              env: [{ name: "CONF_GOLDEN_MARKER", value: `marker-${tier.name}` }],
            },
          ],
        });
        sessionId = ((await client.response(newId))["result"] as { sessionId: string }).sessionId;
        expect(sessionId).toMatch(/^ses_/);

        faux.setResponses([
          fauxAssistantMessage(
            [fauxToolCall("bash", { command: 'printf "golden=%s pwd=%s" "$CONF_GOLDEN_MARKER" "$PWD"' })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Conformance turn done.", { stopReason: "stop" }),
        ]);

        const promptId = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "[Buzz @mention]\nMessage: prove the tier" }],
        });
        expect((await client.response(promptId))["result"]).toEqual({ stopReason: "end_turn" });

        const completed = client
          .updates()
          .find(
            (update) =>
              update["sessionUpdate"] === "tool_call_update" && update["status"] === "completed",
          );
        expect(completed).toBeDefined();
        const output = JSON.stringify(completed);
        expect(output).toContain(`golden=marker-${tier.name}`);

        // M0.5: the registry-wrapped tier emits one audit line per exec —
        // versioned schema, argv0 + hash only, violations attached.
        unsubscribe();
        const goldenCommand = 'printf "golden=%s pwd=%s" "$CONF_GOLDEN_MARKER" "$PWD"';
        const auditLine = auditLines.find(
          (line) => line.cmd_sha256 === createHash("sha256").update(goldenCommand).digest("hex"),
        );
        expect(auditLine).toMatchObject({
          v: 1,
          tier: tier.name,
          argv0: "printf",
          exit: 0,
          violations: [],
        });
        expect(auditLine?.cwd).toBe(workspace);
        expect(auditLine?.ms).toBeGreaterThanOrEqual(0);
      });

      it("cancel during a sandboxed exec → durable abort → stopReason cancelled", async () => {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
            stopReason: "toolUse",
          }),
          // Never reached on this turn: the cancel below aborts the run.
          fauxAssistantMessage("unreachable", { stopReason: "stop" }),
        ]);

        const before = client.updates().length;
        const promptId = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "[Buzz @mention]\nMessage: run something slow" }],
        });
        // Wait for the tool call to be visibly in flight before cancelling.
        await client.waitFor((frame) => {
          if (frame["method"] !== "session/update") return false;
          const update = (frame["params"] as { update?: Record<string, unknown> } | undefined)
            ?.update;
          return (
            update?.["sessionUpdate"] === "tool_call" &&
            client.updates().length > before
          );
        });
        client.notification("session/cancel", { sessionId });
        const response = await client.response(promptId);
        expect(response["result"]).toEqual({ stopReason: "cancelled" });

        // Durable abort: the session answers the next turn cleanly.
        faux.setResponses([fauxAssistantMessage("Alive after cancel.", { stopReason: "stop" })]);
        const nextId = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "still there?" }],
        });
        expect((await client.response(nextId))["result"]).toEqual({ stopReason: "end_turn" });
      });
    });
  });
}
