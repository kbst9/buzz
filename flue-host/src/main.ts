#!/usr/bin/env node
import { createRequire } from "node:module";
import { AcpServer } from "./acp/server.js";
import { createFlueEngine } from "./engine/flue.js";
import { log } from "./log.js";

/**
 * flue-acp — the ACP agent command for buzz-acp (`BUZZ_ACP_AGENT_COMMAND`).
 *
 * Env contract:
 *   BUZZ_FLUE_MODEL  (required)  Flue model specifier, e.g. `xai/grok-4.5`.
 *                                Provider credentials resolve from the
 *                                environment host-side (API keys / tokens);
 *                                they never enter the sandbox.
 *   BUZZ_FLUE_DB     (optional)  SQLite path for Flue persistence;
 *                                default `:memory:`.
 *   BUZZ_FLUE_LOG    (optional)  stderr log level (debug|info|warn|error).
 */
async function main(): Promise<void> {
  const version = readVersion();
  // buzz-acp defaults BUZZ_ACP_AGENT_ARGS to "acp" and only known agent
  // commands get that default stripped — tolerate the stray argument.
  const args = process.argv.slice(2).filter((arg) => arg !== "acp");
  if (args.includes("--version")) {
    process.stdout.write(`flue-acp ${version}\n`);
    return;
  }
  if (args.length > 0) log.warn("ignoring unrecognized arguments", { args });

  const model = process.env["BUZZ_FLUE_MODEL"];
  if (!model) {
    process.stderr.write("[flue-acp] error: BUZZ_FLUE_MODEL is not set (e.g. BUZZ_FLUE_MODEL=xai/grok-4.5)\n");
    process.exitCode = 2;
    return;
  }

  const engine = await createFlueEngine({
    model,
    ...(process.env["BUZZ_FLUE_DB"] ? { db: process.env["BUZZ_FLUE_DB"] } : {}),
  });

  const shutdown = (signal: string): void => {
    log.info("shutting down", { signal });
    void engine.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  log.info("serving ACP", { model, version });
  await new AcpServer(engine, { input: process.stdin, output: process.stdout }, { version }).run();
  await engine.stop();
}

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`[flue-acp] fatal: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exit(1);
});
