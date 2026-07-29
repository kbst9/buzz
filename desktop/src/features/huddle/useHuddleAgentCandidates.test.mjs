import { strict as assert } from "node:assert";
import test from "node:test";

import { mergeHuddleAgentCandidates } from "./useHuddleAgentCandidates.ts";

const MANAGED_PUBKEY = "a".repeat(64);
const CONNECTED_PUBKEY = "b".repeat(64);
const OTHER_PUBKEY = "c".repeat(64);

function managedAgent(overrides = {}) {
  return {
    pubkey: MANAGED_PUBKEY,
    name: "Ned",
    status: "running",
    ...overrides,
  };
}

function directoryUser(overrides = {}) {
  return {
    pubkey: CONNECTED_PUBKEY,
    displayName: "Scout",
    nip05Handle: null,
    isAgent: true,
    ...overrides,
  };
}

test("managed-only: running managed agents come back as online managed candidates", () => {
  const candidates = mergeHuddleAgentCandidates([managedAgent()], []);

  assert.deepEqual(candidates, [
    {
      pubkey: MANAGED_PUBKEY,
      name: "Ned",
      source: "managed",
      online: true,
    },
  ]);
});

test("running filter: non-running managed agents are dropped", () => {
  const candidates = mergeHuddleAgentCandidates(
    [
      managedAgent({ pubkey: MANAGED_PUBKEY, status: "stopped" }),
      managedAgent({ pubkey: CONNECTED_PUBKEY, status: "not_deployed" }),
      managedAgent({ pubkey: OTHER_PUBKEY, name: "Bart", status: "running" }),
    ],
    [],
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [OTHER_PUBKEY],
  );
});

test("connected-only: verified directory agents are offered with relay presence", () => {
  const candidates = mergeHuddleAgentCandidates(
    [],
    [
      directoryUser(),
      directoryUser({ pubkey: OTHER_PUBKEY, displayName: "Lurker" }),
    ],
    { [CONNECTED_PUBKEY]: "online", [OTHER_PUBKEY]: "away" },
  );

  assert.deepEqual(candidates, [
    {
      pubkey: CONNECTED_PUBKEY,
      name: "Scout",
      source: "connected",
      online: true,
    },
    {
      pubkey: OTHER_PUBKEY,
      name: "Lurker",
      source: "connected",
      online: false,
    },
  ]);
});

test("connected candidates default to offline without presence data", () => {
  const candidates = mergeHuddleAgentCandidates([], [directoryUser()]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].online, false);
});

test("non-agent directory results are excluded", () => {
  const candidates = mergeHuddleAgentCandidates(
    [],
    [directoryUser({ pubkey: OTHER_PUBKEY, isAgent: false }), directoryUser()],
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.pubkey),
    [CONNECTED_PUBKEY],
  );
});

test("dedupe: a running managed pubkey is not re-offered as connected", () => {
  const candidates = mergeHuddleAgentCandidates(
    // Uppercase on the managed side to prove matching is normalized.
    [managedAgent({ pubkey: MANAGED_PUBKEY.toUpperCase() })],
    [directoryUser({ pubkey: MANAGED_PUBKEY, displayName: "Ned (relay)" })],
    { [MANAGED_PUBKEY]: "online" },
  );

  assert.deepEqual(candidates, [
    {
      pubkey: MANAGED_PUBKEY,
      name: "Ned",
      source: "managed",
      online: true,
    },
  ]);
});

test("dedupe: a stopped managed pubkey stays hidden instead of appearing connected", () => {
  const candidates = mergeHuddleAgentCandidates(
    [managedAgent({ status: "stopped" })],
    [directoryUser({ pubkey: MANAGED_PUBKEY })],
  );

  assert.deepEqual(candidates, []);
});

test("dedupe: repeated directory entries collapse to one candidate", () => {
  const candidates = mergeHuddleAgentCandidates(
    [],
    [
      directoryUser(),
      directoryUser({ pubkey: CONNECTED_PUBKEY.toUpperCase() }),
    ],
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].pubkey, CONNECTED_PUBKEY);
});

test("connected names fall back from display name to handle to truncated pubkey", () => {
  const candidates = mergeHuddleAgentCandidates(
    [],
    [
      directoryUser({ displayName: null, nip05Handle: "scout" }),
      directoryUser({
        pubkey: OTHER_PUBKEY,
        displayName: "  ",
        nip05Handle: null,
      }),
    ],
  );

  assert.equal(candidates[0].name, "scout");
  assert.equal(candidates[1].name, `${"c".repeat(8)}…${"c".repeat(4)}`);
});
