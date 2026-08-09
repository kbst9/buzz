import { local } from "@flue/runtime/node";
import type { SandboxTier } from "./types.js";

/**
 * The `local` tier: Flue's built-in host-process sandbox. No isolation
 * boundary — containment is the explicit env allowlist only (the interim
 * posture AGENTOS_HOST_PLAN.md documents). Native binaries and git work
 * because the "sandbox" IS the host; egress is unrestricted, so the
 * `egress-allowlist` capability is deliberately absent and `options.egress`
 * is ignored.
 */
export const localTier: SandboxTier = {
  name: "local",
  capabilities: ["native", "git"],
  createFactory: ({ cwd, env }) => local({ cwd, env }),
};
