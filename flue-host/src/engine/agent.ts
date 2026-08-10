import { useInitialData, useModel, useSandbox } from "@flue/runtime";
import { selectSandboxTier } from "../sandbox/registry.js";
import type { SessionSeed } from "./types.js";

/**
 * The one Flue agent this host serves. Everything session-specific — cwd,
 * system prompt, sandbox env — arrives as instance initialData seeded by the
 * first dispatch, so a single registered agent function covers every ACP
 * session (each session is its own Flue instance, addressed by session id).
 *
 * `useSandbox` is what grants the built-in coding toolset (bash, read,
 * write, edit, grep, glob); without it the agent has no environment at all.
 * The sandbox comes from the tier registry (`src/sandbox/`): the
 * `BUZZ_FLUE_SANDBOX` env var picks the tier at session start (default
 * `local`), so the canary switches tiers by env edit + restart, no rebuild.
 * The sandbox env is passed explicitly — tiers deliberately do not inherit
 * the host environment; the shell sees only what the seed grants (the
 * BUZZ_* auth vars that make the `buzz` CLI work).
 */
export function BuzzAgent(): string {
  const seed = useInitialData<SessionSeed | undefined>();
  const model = process.env["BUZZ_FLUE_MODEL"];
  if (!model) {
    // main() refuses to boot without a model; this guards direct embedding.
    throw new Error("BUZZ_FLUE_MODEL is not set");
  }
  useModel(model);
  const tier = selectSandboxTier();
  useSandbox(
    tier.createFactory({ cwd: seed?.cwd ?? process.cwd(), env: seed?.env ?? {} }),
  );
  return (
    seed?.systemPrompt ??
    "You are a Buzz agent. Use your sandbox tools to complete the task you are given."
  );
}
