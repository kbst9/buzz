import { auditingTier } from "./audit.js";
import { dockerTier } from "./docker.js";
import { localTier } from "./local.js";
import { srtTier } from "./srt.js";
import type { SandboxTier } from "./types.js";

/**
 * Sandbox-tier registry + selector (AGENT_OS_M0.md invariant 1). All tier
 * factories live in this directory, one file per tier, registered here by
 * name. `BUZZ_FLUE_SANDBOX` selects the tier at session start; unset means
 * `local` (today's behavior). Unknown names fail loudly at session start —
 * a typo'd tier must never silently fall back to weaker containment.
 *
 * Adding or removing a tier touches: the tier file, its registration line
 * below, and its conformance registration — nothing else.
 */

const DEFAULT_TIER = "local";

const tiers = new Map<string, SandboxTier>();

/**
 * Register a tier under its name. Duplicate names are a programmer error.
 * Registered tiers are wrapped with the per-exec audit log (M0.5) — every
 * tier the selector hands out audits for free; raw tier objects stay
 * available to the conformance suite via direct import.
 */
export function registerSandboxTier(tier: SandboxTier): void {
  if (tiers.has(tier.name)) {
    throw new Error(`sandbox tier "${tier.name}" is already registered`);
  }
  tiers.set(tier.name, auditingTier(tier));
}

/** Look up a tier by name, failing loudly with the known names. */
export function getSandboxTier(name: string): SandboxTier {
  const tier = tiers.get(name);
  if (!tier) {
    throw new Error(
      `unknown sandbox tier "${name}" (BUZZ_FLUE_SANDBOX); registered: ${[...tiers.keys()].join(", ")}`,
    );
  }
  return tier;
}

/** The tier name `env` selects (default: `local`). */
export function selectedSandboxTierName(
  env: Record<string, string | undefined> = process.env,
): string {
  const name = env["BUZZ_FLUE_SANDBOX"]?.trim();
  return name === undefined || name === "" ? DEFAULT_TIER : name;
}

/** Resolve the selected tier from the environment. */
export function selectSandboxTier(
  env: Record<string, string | undefined> = process.env,
): SandboxTier {
  return getSandboxTier(selectedSandboxTierName(env));
}

registerSandboxTier(localTier);
registerSandboxTier(srtTier);
registerSandboxTier(dockerTier);
