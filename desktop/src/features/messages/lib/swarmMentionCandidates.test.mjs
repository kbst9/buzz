import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSwarmMentionCandidates,
  buildSwarmMentionTags,
} from "./swarmMentionCandidates.ts";

const LEADER = "a".repeat(64);
const MEMBER = "b".repeat(64);
const ME = "e".repeat(64);

function swarm(overrides = {}) {
  return {
    id: "swarm-1",
    name: "Build crew",
    leaderPubkey: LEADER,
    members: [{ pubkey: MEMBER }],
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildSwarmMentionCandidates({
    swarms: [swarm()],
    channelType: "stream",
    currentPubkey: ME,
    directoryAgentsByPubkey: new Map(),
    memberPubkeys: new Set(),
    mentionableAgentPubkeys: new Set([LEADER]),
    resolveLeaderLabel: () => "Beeatrice",
    ...overrides,
  });
}

// ── candidate building ───────────────────────────────────────────────────

test("offers a swarm candidate carrying the LEADER pubkey and the swarm id", () => {
  const candidates = build();
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.kind, "swarm");
  assert.equal(candidate.swarmId, "swarm-1");
  assert.equal(candidate.pubkey, LEADER);
  assert.equal(candidate.displayName, "Build crew");
  assert.equal(candidate.isAgent, true);
  assert.equal(candidate.swarmMemberCount, 1);
});

test("only channel composers get swarm candidates — never DMs or forums", () => {
  for (const channelType of ["dm", "forum", null, undefined]) {
    assert.deepEqual(build({ channelType }), []);
  }
});

test("a member leader is always audible, even with an excluding allowlist", () => {
  const candidates = build({
    memberPubkeys: new Set([LEADER]),
    mentionableAgentPubkeys: new Set(),
    directoryAgentsByPubkey: new Map([
      [LEADER, { respondTo: "allowlist", respondToAllowlist: [] }],
    ]),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].isMember, true);
});

test("a non-member, non-invocable leader hides the swarm (reuses the mention gate)", () => {
  assert.deepEqual(
    build({ memberPubkeys: new Set(), mentionableAgentPubkeys: new Set() }),
    [],
  );
});

test("unnamed swarms label as {Leader}'s swarm, truncated pubkey when unknown", () => {
  const named = build({ swarms: [swarm({ name: "  " })] });
  assert.equal(named[0].displayName, "Beeatrice's swarm");

  const unknown = build({
    swarms: [swarm({ name: "" })],
    resolveLeaderLabel: () => null,
  });
  assert.match(unknown[0].displayName, /'s swarm$/);
  assert.notEqual(unknown[0].displayName, "'s swarm");
});

test("leaderless definitions are skipped", () => {
  assert.deepEqual(build({ swarms: [swarm({ leaderPubkey: "" })] }), []);
});

// ── tag emission ─────────────────────────────────────────────────────────

test('emits ["swarm", id] only for swarm mentions present in the text', () => {
  const swarmMentions = new Map([
    ["Build crew", "swarm-1"],
    ["Ship crew", "swarm-2"],
  ]);
  assert.deepEqual(
    buildSwarmMentionTags("hey @Build crew please ship", swarmMentions),
    [["swarm", "swarm-1"]],
  );
  assert.deepEqual(
    buildSwarmMentionTags("no mentions here", swarmMentions),
    [],
  );
});

test("duplicate ids collapse and empty ids are ignored", () => {
  const swarmMentions = new Map([
    ["Build crew", "swarm-1"],
    ["The builders", "swarm-1"],
    ["Broken", ""],
  ]);
  assert.deepEqual(
    buildSwarmMentionTags(
      "@Build crew and @The builders and @Broken",
      swarmMentions,
    ),
    [["swarm", "swarm-1"]],
  );
});
