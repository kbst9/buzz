import { useInitialData, useModel, useSandbox } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import type { SessionSeed } from "./types.js";

/**
 * The one Flue agent this host serves. Everything session-specific — cwd,
 * system prompt, sandbox env — arrives as instance initialData seeded by the
 * first dispatch, so a single registered agent function covers every ACP
 * session (each session is its own Flue instance, addressed by session id).
 *
 * `useSandbox` is what grants the built-in coding toolset (bash, read,
 * write, edit, grep, glob); without it the agent has no environment at all.
 * The sandbox env is passed explicitly — Flue's `local()` deliberately does
 * not inherit the host environment, which is exactly the containment we
 * want: the shell sees only what the seed grants (the BUZZ_* auth vars that
 * make the `buzz` CLI work).
 */
export function BuzzAgent(): string {
  const seed = useInitialData<SessionSeed | undefined>();
  const model = process.env["BUZZ_FLUE_MODEL"];
  if (!model) {
    // main() refuses to boot without a model; this guards direct embedding.
    throw new Error("BUZZ_FLUE_MODEL is not set");
  }
  useModel(model);
  useSandbox(local({ cwd: seed?.cwd ?? process.cwd(), env: seed?.env ?? {} }));
  return (
    seed?.systemPrompt ??
    "You are a Buzz agent. Use your sandbox tools to complete the task you are given."
  );
}
