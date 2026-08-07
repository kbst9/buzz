/**
 * Provision a fleet of flue-tier agents from fleet.toml — the batch sibling
 * of scripts/new-standalone-agent.sh (block/buzz), sharing one multi-use
 * agent invite across every entry.
 *
 *   sudo -v && pnpm exec tsx scripts/provision-fleet.ts [fleet.toml] [--dry-run]
 *
 * Idempotent: an agent whose env file already exists is left untouched, so
 * re-running after adding entries provisions only the new ones. Keypairs are
 * generated on this host via `buzz keys generate`; secrets go only into the
 * root-owned env files, never to stdout.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { parseFleetConfig } from "../src/fleet/config.js";
import {
  agentPaths,
  renderEnvFile,
  renderProviderDropIn,
  renderUnitFile,
} from "../src/fleet/plan.js";

const run = promisify(execFile);

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function which(binary: string): Promise<string> {
  try {
    const { stdout } = await run("command", ["-v", binary], { shell: "/bin/sh" });
    const path = stdout.trim();
    if (path === "") throw new Error("empty");
    return path;
  } catch {
    fail(`${binary} not on PATH (cargo build --release -p ${binary === "buzz" ? "buzz-cli" : binary})`);
  }
}

async function generateKeypair(): Promise<{ secret: string; pubkey: string }> {
  const { stdout } = await run("buzz", ["keys", "generate"]);
  const secret = /"private_key":"([0-9a-f]{64})"/.exec(stdout)?.[1];
  const pubkey = /"public_key":"([0-9a-f]{64})"/.exec(stdout)?.[1];
  if (!secret || !pubkey) fail("buzz keys generate returned no keypair");
  return { secret, pubkey };
}

/** Write `content` to a root-owned path via sudo, without a shell. */
async function sudoWrite(
  path: string,
  content: string,
  mode: string,
  owner?: string,
): Promise<void> {
  await run("sudo", ["install", "-m", mode, ...(owner ? ["-o", owner] : []), "/dev/null", path]);
  await new Promise<void>((resolve, reject) => {
    const child = execFile("sudo", ["tee", path], (error) =>
      error ? reject(error) : resolve(),
    );
    child.stdin?.end(content);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const configPath = args.find((arg) => !arg.startsWith("--")) ?? "fleet.toml";

  if (!existsSync(configPath)) fail(`${configPath} not found`);
  const config = parseFleetConfig(readFileSync(configPath, "utf8"));

  if (config.fleet.providerEnv && !existsSync(config.fleet.providerEnv)) {
    fail(
      `fleet.provider_env ${config.fleet.providerEnv} does not exist on this host`,
    );
  }

  const acpBinary = dryRun ? "/usr/local/bin/buzz-acp" : await which("buzz-acp");
  if (!dryRun) await which("buzz");

  const provisioned: Array<{ name: string; pubkey: string }> = [];
  let skipped = 0;

  for (const agent of config.agents) {
    const paths = agentPaths(agent.name);
    if (existsSync(paths.envFile)) {
      console.log(`skip ${agent.name}: ${paths.envFile} already exists`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`would provision ${agent.name}:`);
      console.log(`  env:  ${paths.envFile} (model ${agent.model}, respond_to ${agent.respondTo})`);
      console.log(`  unit: ${paths.unitFile}`);
      if (config.fleet.providerEnv) console.log(`  drop-in: ${paths.dropInFile}`);
      continue;
    }

    const { secret, pubkey } = await generateKeypair();
    await sudoWrite(
      paths.envFile,
      renderEnvFile(config.fleet, agent, secret),
      "0600",
      config.fleet.runUser,
    );
    await sudoWrite(
      paths.unitFile,
      renderUnitFile(config.fleet, agent, acpBinary),
      "0644",
    );
    if (config.fleet.providerEnv) {
      await run("sudo", ["install", "-d", "-m", "0755", paths.dropInDir]);
      await sudoWrite(
        paths.dropInFile,
        renderProviderDropIn(config.fleet.providerEnv),
        "0644",
      );
    }
    provisioned.push({ name: agent.name, pubkey });
    console.log(`provisioned ${agent.name}: pubkey ${pubkey}`);
  }

  if (!dryRun && provisioned.length > 0) {
    await run("sudo", ["systemctl", "daemon-reload"]);
    for (const { name } of provisioned) {
      await run("sudo", ["systemctl", "enable", "--now", `buzz-acp-${name}`]);
      console.log(`started buzz-acp-${name}`);
    }
  }

  console.log(
    `done: ${provisioned.length} provisioned, ${skipped} already present, ${config.agents.length} total`,
  );
  if (provisioned.length > 0) {
    console.log(`verify each: journalctl -u buzz-acp-<name> -f
  expect: "community invite claimed" + "workspace seeded" + "profile published"
Invite budget: each first connect draws one use — mint with enough uses for the fleet.`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
