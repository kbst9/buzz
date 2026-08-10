import { localTier } from "../../src/sandbox/local.js";
import { describeSandboxConformance } from "./conformance.js";

/**
 * Conformance registration for the `local` tier — the M0.2 baseline run.
 * `local` declares `native` + `git`; the only skipped stage is
 * `egress-allowlist` (the one sanctioned skip: the local tier enforces no
 * egress policy by design).
 *
 * This file is the whole cost of putting a tier under the gate. A new tier
 * (M1's `srt`, later `agentos`, `heavy`) adds one sibling file exactly like
 * it: import the tier, call describeSandboxConformance.
 */
describeSandboxConformance(localTier);
