import assert from "node:assert/strict";
import test from "node:test";

import {
  connectedAgentLabel,
  selectConnectedAgents,
  synthesizeConnectedAgentRecord,
} from "./connectedAgentRecords.ts";

const VIEWER = "f".repeat(64);
const OTHER_OWNER = "0".repeat(64);

function pk(seed) {
  return seed.repeat(64 / seed.length).slice(0, 64);
}

function user(overrides = {}) {
  return {
    pubkey: pk("a"),
    displayName: null,
    avatarUrl: null,
    nip05Handle: null,
    ownerPubkey: null,
    isAgent: true,
    ...overrides,
  };
}

test("keeps only verified agents", () => {
  const agents = selectConnectedAgents(
    [
      user({ pubkey: pk("a"), displayName: "Agent", isAgent: true }),
      user({ pubkey: pk("b"), displayName: "Human", isAgent: false }),
    ],
    new Set(),
    null,
  );
  assert.deepEqual(
    agents.map((agent) => agent.pubkey),
    [pk("a")],
  );
});

test("excludes pubkeys already in the managed list, case-insensitively", () => {
  const managedUpper = pk("a").toUpperCase();
  const agents = selectConnectedAgents(
    [
      user({ pubkey: managedUpper, displayName: "Managed dupe" }),
      user({ pubkey: pk("b"), displayName: "Standalone" }),
    ],
    new Set([pk("a")]),
    null,
  );
  assert.deepEqual(
    agents.map((agent) => agent.pubkey),
    [pk("b")],
  );
});

test("dedupes repeated directory entries by normalized pubkey", () => {
  const agents = selectConnectedAgents(
    [
      user({ pubkey: pk("a"), displayName: "First" }),
      user({ pubkey: pk("a").toUpperCase(), displayName: "Second copy" }),
    ],
    new Set(),
    null,
  );
  assert.equal(agents.length, 1);
  assert.equal(agents[0].displayName, "First");
});

test("sorts owned-by-viewer first, then by label within each group", () => {
  const agents = selectConnectedAgents(
    [
      user({ pubkey: pk("a"), displayName: "Zeta", ownerPubkey: OTHER_OWNER }),
      user({ pubkey: pk("b"), displayName: "Beta", ownerPubkey: VIEWER }),
      user({ pubkey: pk("c"), displayName: "Alpha", ownerPubkey: OTHER_OWNER }),
      user({ pubkey: pk("d"), displayName: "Delta", ownerPubkey: VIEWER }),
    ],
    new Set(),
    VIEWER,
  );
  assert.deepEqual(
    agents.map((agent) => agent.displayName),
    ["Beta", "Delta", "Alpha", "Zeta"],
  );
});

test("without a viewer pubkey, sorts purely by label", () => {
  const agents = selectConnectedAgents(
    [
      user({ pubkey: pk("a"), displayName: "Zeta", ownerPubkey: OTHER_OWNER }),
      user({ pubkey: pk("b"), displayName: "Alpha" }),
    ],
    new Set(),
    null,
  );
  assert.deepEqual(
    agents.map((agent) => agent.displayName),
    ["Alpha", "Zeta"],
  );
});

test("label falls back displayName → nip05 handle → truncated pubkey", () => {
  assert.equal(connectedAgentLabel(user({ displayName: "Nova" })), "Nova");
  assert.equal(
    connectedAgentLabel(
      user({ displayName: "  ", nip05Handle: "nova@example.com" }),
    ),
    "nova@example.com",
  );
  const bare = user({ pubkey: pk("a") });
  const label = connectedAgentLabel(bare);
  assert.equal(label, `${pk("a").slice(0, 8)}…${pk("a").slice(-4)}`);
});

test("synthesizes a deployed provider/connected ManagedAgent record", () => {
  const record = synthesizeConnectedAgentRecord(
    user({
      pubkey: pk("a"),
      displayName: "Nova",
      avatarUrl: "https://example.com/nova.png",
      ownerPubkey: OTHER_OWNER,
    }),
  );
  assert.equal(record.pubkey, pk("a"));
  assert.equal(record.name, "Nova");
  assert.equal(record.status, "deployed");
  assert.deepEqual(record.backend, {
    type: "provider",
    id: "connected",
    config: {},
  });
  assert.equal(record.avatarUrl, "https://example.com/nova.png");
  // Managed-only chrome gates on backend.type === "local"; a synthesized
  // record must never look local or carry process state.
  assert.notEqual(record.backend.type, "local");
  assert.equal(record.pid, null);
  assert.equal(record.personaId, null);
  assert.equal(record.lastError, null);
});

test("synthesized name uses the same fallback chain as the label", () => {
  const record = synthesizeConnectedAgentRecord(
    user({ pubkey: pk("b"), nip05Handle: "beta@example.com" }),
  );
  assert.equal(record.name, "beta@example.com");
  const bare = synthesizeConnectedAgentRecord(user({ pubkey: pk("c") }));
  assert.equal(bare.name, `${pk("c").slice(0, 8)}…${pk("c").slice(-4)}`);
});
