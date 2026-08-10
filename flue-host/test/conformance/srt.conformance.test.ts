import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterAll } from "vitest";
import { resetSrtForTests, srtTier } from "../../src/sandbox/srt.js";
import { describeSandboxConformance } from "./conformance.js";

/**
 * Conformance registration for the `srt` light tier (M1). srt declares
 * `native` + `git` + `egress-allowlist` — it runs the FULL suite including
 * the egress stage the `local` baseline skips.
 *
 * Gated to platforms srt supports (macOS seatbelt, Linux bwrap). On the
 * AppArmor-restricted Linux host the tier sets `allowAllUnixSockets` so the
 * bwrap chain works without a host-security change (see src/sandbox/srt.ts);
 * that is transparent to this suite. Adding the tier to the gate is,
 * exactly as designed, this one ~20-line file.
 */
const supported = SandboxManager.isSupportedPlatform();
if (!supported) {
  // Surface the skip loudly rather than silently passing an empty file.
  // eslint-disable-next-line no-console
  console.warn("[conformance] srt tier skipped: unsupported platform");
}

afterAll(async () => {
  await resetSrtForTests();
});

describeSandboxConformance(srtTier, { skip: !supported });
