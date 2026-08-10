import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { dockerTier, resetDockerForTests } from "../../src/sandbox/docker.js";
import { describeSandboxConformance } from "./conformance.js";

const run = promisify(execFile);

/**
 * Conformance registration for the `docker` heavy tier (M3). It declares
 * native + git + egress-allowlist + fs-projection, so it runs the FULL suite
 * including the egress stage.
 *
 * Gated on Docker being usable AND the base image present — on a dev host
 * without Docker (typical macOS pre-push) it skips loudly rather than fail;
 * gradient CI has both and runs it. Each conformance stage stands up its own
 * container + egress proxy + network (keyed on the stage's temp cwd), all
 * reaped by resetDockerForTests.
 */
async function dockerReady(): Promise<boolean> {
  try {
    await run("docker", ["info"], { timeout: 10_000 });
    const image = process.env["BUZZ_FLUE_DOCKER_IMAGE"] ?? "buzz-heavy-base:latest";
    await run("docker", ["image", "inspect", image], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const ready = await dockerReady();
if (!ready) {
  // eslint-disable-next-line no-console
  console.warn("[conformance] docker tier skipped: docker unavailable or buzz-heavy-base image missing");
}

afterAll(async () => {
  await resetDockerForTests();
});

describeSandboxConformance(dockerTier, { skip: !ready });
