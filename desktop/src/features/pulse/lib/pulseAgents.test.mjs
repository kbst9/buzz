import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPulseMentionMembers,
  isAgentNotePubkey,
  widenAgentPubkeys,
} from "./pulseAgents.ts";

const RELAY_AGENT = "1".repeat(64);
const CONNECTED_AGENT = "2".repeat(64);
const HUMAN = "3".repeat(64);
const CURRENT_USER = "a".repeat(64);

test("widenAgentPubkeys: verified connected agents widen the relay/managed set", () => {
  assert.deepEqual(
    widenAgentPubkeys([RELAY_AGENT], new Set([CONNECTED_AGENT])),
    [RELAY_AGENT, CONNECTED_AGENT],
  );
});

test("widenAgentPubkeys: dedupes overlap and normalizes case", () => {
  assert.deepEqual(
    widenAgentPubkeys(
      [RELAY_AGENT.toUpperCase(), RELAY_AGENT],
      new Set([RELAY_AGENT, CONNECTED_AGENT.toUpperCase()]),
    ),
    [RELAY_AGENT, CONNECTED_AGENT],
  );
});

test("widenAgentPubkeys: drops blank entries and accepts empty inputs", () => {
  assert.deepEqual(widenAgentPubkeys(["  "], new Set()), []);
  assert.deepEqual(widenAgentPubkeys([], new Set([CONNECTED_AGENT])), [
    CONNECTED_AGENT,
  ]);
});

test("isAgentNotePubkey: classifies via the widened set", () => {
  const agentPubkeySet = new Set([CONNECTED_AGENT]);

  assert.equal(isAgentNotePubkey(CONNECTED_AGENT, agentPubkeySet), true);
  assert.equal(
    isAgentNotePubkey(CONNECTED_AGENT.toUpperCase(), agentPubkeySet),
    true,
  );
  assert.equal(isAgentNotePubkey(HUMAN, agentPubkeySet), false);
});

test("isAgentNotePubkey: ORs in the verified profile flag beyond the set", () => {
  const profiles = {
    [CONNECTED_AGENT]: { isAgent: true },
    [HUMAN]: { isAgent: false },
    [RELAY_AGENT]: { isAgent: null },
  };

  assert.equal(isAgentNotePubkey(CONNECTED_AGENT, new Set(), profiles), true);
  assert.equal(isAgentNotePubkey(HUMAN, new Set(), profiles), false);
  assert.equal(isAgentNotePubkey(RELAY_AGENT, new Set(), profiles), false);
  assert.equal(isAgentNotePubkey(HUMAN, new Set()), false);
});

test("buildPulseMentionMembers: every row carries isMember: true", () => {
  const members = buildPulseMentionMembers(
    [CURRENT_USER, HUMAN, CONNECTED_AGENT],
    {},
    new Set([CONNECTED_AGENT]),
  );

  assert.equal(members.length, 3);
  for (const member of members) {
    assert.equal(member.isMember, true);
    assert.equal(member.role, "member");
    assert.equal(member.joinedAt, "");
  }
});

test("buildPulseMentionMembers: classifies agents via set OR profile flag", () => {
  const members = buildPulseMentionMembers(
    [CONNECTED_AGENT, RELAY_AGENT, HUMAN],
    {
      [RELAY_AGENT]: { displayName: "Pinky", isAgent: true },
      [HUMAN]: { displayName: "Alice", isAgent: false },
    },
    new Set([CONNECTED_AGENT]),
  );

  assert.deepEqual(
    members.map((m) => ({ pubkey: m.pubkey, isAgent: m.isAgent })),
    [
      // In the widened set, no profile yet.
      { pubkey: CONNECTED_AGENT, isAgent: true },
      // Not in the set, verified profile flag.
      { pubkey: RELAY_AGENT, isAgent: true },
      { pubkey: HUMAN, isAgent: false },
    ],
  );
});

test("buildPulseMentionMembers: resolves display names from normalized profile keys", () => {
  const members = buildPulseMentionMembers(
    [HUMAN.toUpperCase(), CONNECTED_AGENT],
    { [HUMAN]: { displayName: "Alice" } },
    new Set(),
  );

  assert.equal(members[0].pubkey, HUMAN.toUpperCase());
  assert.equal(members[0].displayName, "Alice");
  assert.equal(members[1].displayName, null);
});
