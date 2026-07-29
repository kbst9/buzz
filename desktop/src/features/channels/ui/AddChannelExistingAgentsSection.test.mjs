/**
 * Candidate selection for the "Existing agents" section of the channel
 * "Add agents" dialog (T1.4): verified connected agents from the community
 * directory, minus channel members and locally managed agents, deduped and
 * viewer-owned-first. The component delegates to the pure helper under test
 * here; the member-add itself rides the same mutation the members-sidebar
 * picker uses and is covered by that path.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  formatExistingAgentLabel,
  selectAddChannelExistingAgentCandidates,
} from "@/features/channels/ui/addChannelExistingAgentCandidates.ts";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);
const PK_C = "c".repeat(64);
const PK_D = "d".repeat(64);
const VIEWER = "f".repeat(64);

function agent(pubkey, overrides = {}) {
  return {
    pubkey,
    displayName: null,
    avatarUrl: null,
    nip05Handle: null,
    ownerPubkey: null,
    isAgent: true,
    ...overrides,
  };
}

test("includes verified agents that are not channel members", () => {
  const candidates = selectAddChannelExistingAgentCandidates({
    memberPubkeys: [],
    users: [
      agent(PK_A, { displayName: "Alpha" }),
      agent(PK_B, { displayName: "Beta" }),
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [PK_A, PK_B],
  );
});

test("excludes agents already members of the channel, case-insensitively", () => {
  const candidates = selectAddChannelExistingAgentCandidates({
    memberPubkeys: [PK_A.toUpperCase(), ` ${PK_B} `],
    users: [
      agent(PK_A, { displayName: "Alpha" }),
      agent(PK_B, { displayName: "Beta" }),
      agent(PK_C, { displayName: "Gamma" }),
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [PK_C],
  );
});

test("excludes non-agent directory users", () => {
  const candidates = selectAddChannelExistingAgentCandidates({
    memberPubkeys: [],
    users: [
      agent(PK_A, { displayName: "Human", isAgent: false }),
      agent(PK_B, { displayName: "Agent" }),
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [PK_B],
  );
});

test("dedupes repeated directory entries by normalized pubkey, first wins", () => {
  const candidates = selectAddChannelExistingAgentCandidates({
    memberPubkeys: [],
    users: [
      agent(PK_A, { displayName: "First" }),
      agent(PK_A.toUpperCase(), { displayName: "Second" }),
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].displayName, "First");
});

test("excludes locally managed agents via excludedPubkeys", () => {
  const candidates = selectAddChannelExistingAgentCandidates({
    excludedPubkeys: [PK_A],
    memberPubkeys: [],
    users: [
      agent(PK_A, { displayName: "Managed" }),
      agent(PK_B, { displayName: "Connected" }),
    ],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [PK_B],
  );
});

test("sorts viewer-owned agents first, then by label", () => {
  const candidates = selectAddChannelExistingAgentCandidates({
    memberPubkeys: [],
    users: [
      agent(PK_A, { displayName: "Zulu", ownerPubkey: PK_D }),
      agent(PK_B, { displayName: "Yankee", ownerPubkey: VIEWER.toUpperCase() }),
      agent(PK_C, { displayName: "Alpha" }),
    ],
    viewerPubkey: VIEWER,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.displayName),
    ["Yankee", "Alpha", "Zulu"],
  );
});

test("formatExistingAgentLabel falls back displayName → nip05 → truncated pubkey", () => {
  assert.equal(
    formatExistingAgentLabel(agent(PK_A, { displayName: "  Named  " })),
    "Named",
  );
  assert.equal(
    formatExistingAgentLabel(
      agent(PK_A, { displayName: "   ", nip05Handle: "bot@example.com" }),
    ),
    "bot@example.com",
  );
  assert.equal(
    formatExistingAgentLabel(agent(PK_A)),
    `${PK_A.slice(0, 8)}…${PK_A.slice(-4)}`,
  );
});
