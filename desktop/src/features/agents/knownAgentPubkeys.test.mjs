import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeChannelKnownAgentPubkeys,
  mergeKnownAgentPubkeys,
  mergeOwnedAgentPubkeys,
} from "./knownAgentPubkeys.ts";

const MANAGED =
  "1111111111111111111111111111111111111111111111111111111111111111";
const RELAY =
  "2222222222222222222222222222222222222222222222222222222222222222";

test("mergesTrustedSources", () => {
  const merged = mergeKnownAgentPubkeys(
    [{ pubkey: MANAGED }],
    [{ pubkey: RELAY }],
  );

  assert.deepEqual([...merged].sort(), [MANAGED, RELAY].sort());
});

test("undefinedSources_yieldEmptySet", () => {
  const merged = mergeKnownAgentPubkeys(undefined, undefined);

  assert.equal(merged.size, 0);
});

test("normalisesCaseAndWhitespace_dedupingAcrossSources", () => {
  // The same agent appearing in multiple sources with different casing /
  // stray whitespace must collapse to one normalised entry, so membership
  // checks against normalizePubkey output always hit.
  const merged = mergeKnownAgentPubkeys(
    [{ pubkey: MANAGED.toUpperCase() }],
    [{ pubkey: ` ${MANAGED}` }],
  );

  assert.deepEqual([...merged], [MANAGED]);
});

test("owned agents include managed and profile-declared agents", () => {
  const merged = mergeOwnedAgentPubkeys(
    [{ pubkey: MANAGED }],
    {
      [RELAY]: { ownerPubkey: " owner " },
      other: { ownerPubkey: "somebody-else" },
    },
    "OWNER",
  );

  assert.deepEqual([...merged].sort(), [MANAGED, RELAY].sort());
});

test("owned agents exclude agents controlled by somebody else", () => {
  const merged = mergeOwnedAgentPubkeys(
    undefined,
    { [RELAY]: { ownerPubkey: "somebody-else" } },
    "owner",
  );

  assert.equal(merged.size, 0);
});

test("channel-known agents include role, relay flag, and verified-profile members", () => {
  const memberHuman = "1".repeat(64);
  const memberBotRole = "2".repeat(64);
  const memberRelayFlagged = "3".repeat(64);
  const memberAuthTagged = "4".repeat(64);

  const merged = mergeChannelKnownAgentPubkeys(
    [
      { pubkey: memberHuman, role: "member", isAgent: false },
      { pubkey: memberBotRole, role: "bot", isAgent: false },
      { pubkey: memberRelayFlagged, role: "member", isAgent: true },
      {
        pubkey: memberAuthTagged.toUpperCase(),
        role: "member",
        isAgent: false,
      },
    ],
    undefined,
    undefined,
    { [memberAuthTagged]: { isAgent: true } },
  );

  assert.deepEqual(
    [...merged].sort(),
    [memberBotRole, memberRelayFlagged, memberAuthTagged].sort(),
  );
});

test("channel-known agents ignore profile flags for non-members", () => {
  const stranger = "5".repeat(64);
  const merged = mergeChannelKnownAgentPubkeys([], undefined, undefined, {
    [stranger]: { isAgent: true },
  });
  assert.equal(merged.size, 0);
});
