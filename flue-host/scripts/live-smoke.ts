/**
 * Live end-to-end smoke against a REAL model — the one test the suite
 * cannot run for you (it needs a provider credential).
 *
 *   BUZZ_FLUE_MODEL=xai/grok-4.5 XAI_API_KEY=... pnpm smoke
 *
 * Spawns the built `dist/main.js` exactly as buzz-acp would (stdio,
 * NDJSON), plays initialize → session/new → session/prompt, and asks the
 * model to run a bash command in its sandbox. Prints every frame; exits 0
 * on stopReason end_turn with the marker present in a tool result.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MARKER = "flue-live-ok";
const TIMEOUT_MS = 180_000;

if (!process.env["BUZZ_FLUE_MODEL"]) {
  console.error("live-smoke: set BUZZ_FLUE_MODEL (and the matching provider key, e.g. XAI_API_KEY)");
  process.exit(2);
}

const bin = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "main.js");
const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "inherit"] });
const frames: Record<string, unknown>[] = [];
let notify: (() => void) | null = null;

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  console.log("←", line);
  frames.push(JSON.parse(line) as Record<string, unknown>);
  notify?.();
});

let nextId = 0;
function send(method: string, params: unknown): number {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  console.log("→", frame);
  child.stdin.write(`${frame}\n`);
  return id;
}

async function response(id: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const found = frames.find((frame) => frame["id"] === id && !("method" in frame));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for response ${id}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      notify = () => {
        clearTimeout(timer);
        notify = null;
        resolve();
      };
    });
  }
}

const initId = send("initialize", {
  protocolVersion: 2,
  clientCapabilities: { auth: { terminal: true } },
  clientInfo: { name: "live-smoke", version: "0" },
});
await response(initId);

const newId = send("session/new", {
  cwd: mkdtempSync(join(tmpdir(), "flue-live-")),
  mcpServers: [],
  systemPrompt: "You are a smoke-test agent. When asked to run a command, use your bash tool, then repeat its exact output.",
  _meta: { sessionTitle: "live-smoke" },
});
const sessionId = ((await response(newId))["result"] as { sessionId: string }).sessionId;

const promptId = send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: `Run \`echo ${MARKER}\` in your sandbox and tell me exactly what it printed.` }],
});
const result = (await response(promptId))["result"] as { stopReason?: string } | undefined;

child.stdin.end();
const transcript = JSON.stringify(frames);
const pass = result?.stopReason === "end_turn" && transcript.includes(MARKER);
console.log(pass ? `\nlive-smoke PASS (stopReason=${result?.stopReason})` : `\nlive-smoke FAIL (stopReason=${result?.stopReason ?? "none"}, marker ${transcript.includes(MARKER) ? "seen" : "missing"})`);
process.exit(pass ? 0 : 1);
