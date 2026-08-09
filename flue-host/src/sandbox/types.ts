import type { SandboxFactory } from "@flue/runtime";

/**
 * Internal sandbox-tier adapter contract (AGENT_OS_M0.md architecture
 * invariants 1–3). One file per tier under `src/sandbox/` implements
 * {@link SandboxTier} and registers itself by name in `registry.ts`;
 * `BUZZ_FLUE_SANDBOX` selects a tier at session start. Swapping tiers must
 * never require touching agent policy or prompts — everything tier-native
 * stays behind this seam.
 */

/**
 * Capabilities a tier declares. The conformance suite
 * (`test/conformance/`) gates its stages on these:
 *
 * - `native`: real host binaries execute (ELF/Mach-O from disk, not shims).
 * - `git`: a full git round-trip works inside the workspace.
 * - `egress-allowlist`: network egress is deny-by-default with an
 *   allowlist, and denials surface as normalized {@link SandboxViolation}s.
 * - `fs-projection`: the workspace is projected (mount/overlay) rather
 *   than the host filesystem itself.
 */
export type TierCapability = "native" | "git" | "egress-allowlist" | "fs-projection";

/**
 * Normalized policy-violation shape (invariant 3). Adapters map native
 * denials — srt denial reasons, agentOS permission errors, container
 * failures — into this one shape; nothing model-visible ever renders from
 * a tier's native error text.
 */
export interface SandboxViolation {
  /** Policy dimension that fired. */
  kind: "egress" | "filesystem" | "exec" | "resource";
  /** Registry name of the tier that raised it. */
  tier: string;
  /** What was denied, tier-independent: a host[:port], a path, an argv0. */
  target: string;
  /** Native detail for debug logs only. Never rendered to the model. */
  nativeDetail?: string;
}

/**
 * The one model-visible rendering of a violation (invariant 3). Prompts and
 * transcripts couple to THIS line, never to tier-native text — the string
 * must stay stable across tier swaps. Conformance asserts tool results
 * carry exactly this form.
 */
export function renderSandboxViolation(violation: SandboxViolation): string {
  return `[sandbox] ${violation.kind} blocked by policy: ${violation.target}`;
}

/** Options a tier receives when building the factory for one session. */
export interface TierFactoryOptions {
  /** Absolute workspace path (the nest); roots the sandbox. */
  cwd: string;
  /** Allowlisted env exposed inside the sandbox (BUZZ_* auth etc.). */
  env: Record<string, string>;
  /**
   * Egress allowlist in OUR tier-agnostic vocabulary (invariant 2):
   * `"relay"` plus bare `host` / `host:port` entries. Tiers without the
   * `egress-allowlist` capability ignore it (the local tier); tiers with it
   * translate entries into their native mechanism. Populated from the
   * fleet.toml `sandbox` policy block once M1 lands it.
   */
  egress?: readonly string[];
  /**
   * Observer for normalized violations, wired by the registry wrapper
   * (audit log, M0.5). Tiers call it as denials happen, already normalized.
   */
  onViolation?: (violation: SandboxViolation) => void;
}

/** One sandbox tier: a named, capability-declaring SandboxFactory builder. */
export interface SandboxTier {
  /** Registry name — the `BUZZ_FLUE_SANDBOX` value that selects this tier. */
  name: string;
  /** What the conformance suite may assert against this tier. */
  capabilities: readonly TierCapability[];
  /** Build the Flue {@link SandboxFactory} for one session. */
  createFactory(options: TierFactoryOptions): SandboxFactory;
}
