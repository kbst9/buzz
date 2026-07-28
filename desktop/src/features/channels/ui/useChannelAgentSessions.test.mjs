import { strict as assert } from "node:assert";
import test from "node:test";

import {
  buildChannelAgentSessionCandidates,
  getChannelAgentSessionAgents,
} from "./useChannelAgentSessions.ts";

const BOT_ROLE_PUBKEY = "a".repeat(64);
const CONNECTED_PUBKEY = "b".repeat(64);
const HUMAN_PUBKEY = "c".repeat(64);
const MANAGED_PUBKEY = "d".repeat(64);

function member(overrides = {}) {
  return {
    pubkey: HUMAN_PUBKEY,
    role: "member",
    isAgent: false,
    joinedAt: "2026-01-01T00:00:00Z",
    displayName: null,
    ...overrides,
  };
}

function managedAgent(overrides = {}) {
  return {
    pubkey: MANAGED_PUBKEY,
    name: "Fizz",
    status: "deployed",
    ...overrides,
  };
}

function channel(overrides = {}) {
  return {
    id: "channel-1",
    name: "general",
    ...overrides,
  };
}

test("role bot members remain session candidates", () => {
  const candidates = buildChannelAgentSessionCandidates({
    channelMembers: [
      member({ pubkey: BOT_ROLE_PUBKEY, role: "bot", displayName: "Buzzy" }),
    ],
    managedAgents: [],
    relayAgents: [],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pubkey, BOT_ROLE_PUBKEY);
  assert.equal(candidates[0].agentSource, "member-bot");
});

test("verified agent members with role member are session candidates", () => {
  // Standalone/connected agents join with role `member`; only the verified
  // profile flag marks them as agents.
  const candidates = buildChannelAgentSessionCandidates({
    channelMembers: [
      member({
        pubkey: CONNECTED_PUBKEY,
        role: "member",
        isAgent: true,
        displayName: "Nova",
      }),
    ],
    managedAgents: [],
    relayAgents: [],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pubkey, CONNECTED_PUBKEY);
  assert.equal(candidates[0].agentSource, "member-bot");
  assert.equal(candidates[0].canInterruptTurn, false);
});

test("human members are not session candidates", () => {
  const candidates = buildChannelAgentSessionCandidates({
    channelMembers: [member()],
    managedAgents: [],
    relayAgents: [],
  });

  assert.equal(candidates.length, 0);
});

test("managed entry wins over a member row for the same pubkey", () => {
  const candidates = buildChannelAgentSessionCandidates({
    channelMembers: [
      member({ pubkey: MANAGED_PUBKEY, role: "member", isAgent: true }),
    ],
    managedAgents: [managedAgent()],
    relayAgents: [],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].agentSource, "managed");
  assert.equal(candidates[0].canInterruptTurn, true);
});

test("connected member agent passes the active-channel filter", () => {
  const members = [
    member({ pubkey: CONNECTED_PUBKEY, role: "member", isAgent: true }),
  ];
  const agents = buildChannelAgentSessionCandidates({
    channelMembers: members,
    managedAgents: [],
    relayAgents: [],
  });

  const filtered = getChannelAgentSessionAgents({
    activeChannel: channel(),
    activeChannelId: "channel-1",
    agents,
    channelMembers: members,
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].pubkey, CONNECTED_PUBKEY);
});

test("member-bot candidate is excluded once absent from the member list", () => {
  const agents = buildChannelAgentSessionCandidates({
    channelMembers: [
      member({ pubkey: CONNECTED_PUBKEY, role: "member", isAgent: true }),
    ],
    managedAgents: [],
    relayAgents: [],
  });

  const filtered = getChannelAgentSessionAgents({
    activeChannel: channel(),
    activeChannelId: "channel-1",
    agents,
    channelMembers: [],
  });

  assert.equal(filtered.length, 0);
});
