/**
 * Egress-policy vocabulary (tier-agnostic; AGENT_OS_M0.md invariant 2).
 *
 * Our policy vocab is OURS and stable: `"relay"` plus bare `host` /
 * `host:port` entries. Each tier adapter translates it to its native
 * mechanism — the srt tier maps it to srt `allowedDomains`. Swapping tiers
 * must never require re-authoring an agent's egress list.
 */

/** Default egress when a tier needs network but the policy names none: the
 *  relay only. An agent that cannot reach its relay cannot function. */
export const DEFAULT_EGRESS: readonly string[] = ["relay"];

/** Parse the host (no scheme, no path, no port) from a ws(s):// relay URL. */
export function relayHost(relayUrl: string | undefined): string | undefined {
  if (!relayUrl) return undefined;
  try {
    return new URL(relayUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Resolve our egress vocabulary into concrete host/host:port allowlist
 * entries a proxy-based tier consumes. `"relay"` expands to the relay's
 * hostname (from `relayUrl`); every other entry passes through verbatim.
 * Unresolvable `"relay"` (missing or malformed URL) is dropped rather than
 * emitted as a wrong host — the caller decides what an empty allowlist means.
 */
export function resolveEgress(
  egress: readonly string[],
  relayUrl: string | undefined,
): string[] {
  const out: string[] = [];
  const host = relayHost(relayUrl);
  for (const entry of egress) {
    if (entry === "relay") {
      if (host) out.push(host);
    } else {
      out.push(entry);
    }
  }
  // Deduplicate while preserving order.
  return [...new Set(out)];
}
