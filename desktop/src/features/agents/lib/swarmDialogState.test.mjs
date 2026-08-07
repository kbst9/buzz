import assert from "node:assert/strict";
import test from "node:test";

import {
  appendEmptyMemberRow,
  combineSwarmAgentOptions,
  defaultSwarmName,
  memberLeaderWarning,
  memberOptionsForRow,
  memberRowsFromDefinition,
  removeMemberRow,
  rowsToMembers,
  swarmDisplayName,
  updateMemberRow,
  validateSwarmDraft,
} from "./swarmDialogState.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

// ── combineSwarmAgentOptions ─────────────────────────────────────────────

test("combines managed and verified agents, managed name wins on overlap", () => {
  const options = combineSwarmAgentOptions(
    [{ pubkey: A.toUpperCase(), name: "Managed A", avatarUrl: "m.png" }],
    [
      {
        pubkey: A,
        displayName: "Directory A",
        nip05Handle: null,
        avatarUrl: null,
      },
      { pubkey: B, displayName: "Bee", nip05Handle: null, avatarUrl: null },
    ],
  );
  assert.deepEqual(
    options.map((option) => [option.pubkey, option.label]),
    [
      [B, "Bee"],
      [A, "Managed A"],
    ],
  );
});

test("verified labels fall back displayName → nip05 → truncated pubkey", () => {
  const options = combineSwarmAgentOptions(
    [],
    [
      { pubkey: A, displayName: "  ", nip05Handle: "a@host", avatarUrl: null },
      { pubkey: B, displayName: null, nip05Handle: null, avatarUrl: null },
    ],
  );
  const labels = new Map(
    options.map((option) => [option.pubkey, option.label]),
  );
  assert.equal(labels.get(A), "a@host");
  assert.match(labels.get(B), /…|\.\.\.|^b/);
});

// ── row management ───────────────────────────────────────────────────────

test("memberRowsFromDefinition seeds one empty row for an empty swarm", () => {
  const { rows, nextKey } = memberRowsFromDefinition([]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pubkey, "");
  assert.equal(nextKey, 1);
});

test("memberRowsFromDefinition maps stored members to keyed rows", () => {
  const { rows, nextKey } = memberRowsFromDefinition(
    [
      { pubkey: A.toUpperCase(), description: "specs" },
      { pubkey: B, description: "" },
    ],
    5,
  );
  assert.deepEqual(rows, [
    { key: 5, pubkey: A, description: "specs" },
    { key: 6, pubkey: B, description: "" },
  ]);
  assert.equal(nextKey, 7);
});

test("appendEmptyMemberRow adds a row with a fresh key", () => {
  const seed = memberRowsFromDefinition([{ pubkey: A, description: "" }]);
  const { rows, nextKey } = appendEmptyMemberRow(seed.rows, seed.nextKey);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].key, seed.nextKey);
  assert.equal(nextKey, seed.nextKey + 1);
});

test("removeMemberRow drops the row; removing the last leaves one empty row", () => {
  const seed = memberRowsFromDefinition([
    { pubkey: A, description: "x" },
    { pubkey: B, description: "y" },
  ]);
  const afterOne = removeMemberRow(seed.rows, seed.rows[0].key, seed.nextKey);
  assert.deepEqual(
    afterOne.rows.map((row) => row.pubkey),
    [B],
  );
  assert.equal(afterOne.nextKey, seed.nextKey);

  const afterAll = removeMemberRow(
    afterOne.rows,
    afterOne.rows[0].key,
    afterOne.nextKey,
  );
  assert.equal(afterAll.rows.length, 1);
  assert.equal(afterAll.rows[0].pubkey, "");
  assert.equal(afterAll.rows[0].key, afterOne.nextKey);
  assert.equal(afterAll.nextKey, afterOne.nextKey + 1);
});

test("updateMemberRow patches only the targeted row and normalizes pubkeys", () => {
  const seed = memberRowsFromDefinition([
    { pubkey: A, description: "keep" },
    { pubkey: "", description: "" },
  ]);
  const targetKey = seed.rows[1].key;
  let rows = updateMemberRow(seed.rows, targetKey, {
    pubkey: B.toUpperCase(),
  });
  rows = updateMemberRow(rows, targetKey, { description: "do bug fixes" });
  assert.deepEqual(rows, [
    { key: seed.rows[0].key, pubkey: A, description: "keep" },
    { key: targetKey, pubkey: B, description: "do bug fixes" },
  ]);
});

// ── per-row dropdown options ─────────────────────────────────────────────

test("memberOptionsForRow excludes the leader and other rows' picks, keeps own pick", () => {
  const options = [A, B, C].map((pubkey) => ({
    pubkey,
    label: pubkey.slice(0, 4),
    avatarUrl: null,
  }));
  const rows = [
    { key: 0, pubkey: B, description: "" },
    { key: 1, pubkey: C, description: "" },
  ];
  const forRow1 = memberOptionsForRow(options, {
    leaderPubkey: A,
    rows,
    rowKey: 1,
  });
  // A is the leader, B is picked by row 0 — only C (own pick) remains.
  assert.deepEqual(
    forRow1.map((option) => option.pubkey),
    [C],
  );
});

// ── save mapping + validation ────────────────────────────────────────────

test("rowsToMembers drops unpicked rows and keeps descriptions", () => {
  assert.deepEqual(
    rowsToMembers([
      { key: 0, pubkey: A, description: "specs" },
      { key: 1, pubkey: "", description: "ignored" },
    ]),
    [{ pubkey: A, description: "specs" }],
  );
});

test("validateSwarmDraft requires a leader, then at least one member", () => {
  const memberRow = { key: 0, pubkey: A, description: "" };
  const emptyRow = { key: 1, pubkey: "", description: "" };
  assert.match(
    validateSwarmDraft({ leaderPubkey: "", rows: [memberRow] }) ?? "",
    /leader/i,
  );
  assert.match(
    validateSwarmDraft({ leaderPubkey: B, rows: [emptyRow] }) ?? "",
    /member/i,
  );
  assert.equal(
    validateSwarmDraft({ leaderPubkey: B, rows: [memberRow] }),
    null,
  );
});

// ── member/leader respond warning (Option B allowlist signal) ────────────

test("memberLeaderWarning fires only on an allowlist that excludes the leader", () => {
  const base = {
    leaderPubkey: A,
    memberOwnerPubkey: C,
    viewerPubkey: B,
  };
  // Excluding allowlist → warn.
  assert.match(
    memberLeaderWarning({
      ...base,
      directoryEntry: { respondTo: "allowlist", respondToAllowlist: [C] },
    }) ?? "",
    /leader/i,
  );
  // Allowlist admitting the leader → no warning.
  assert.equal(
    memberLeaderWarning({
      ...base,
      directoryEntry: {
        respondTo: "allowlist",
        respondToAllowlist: [A.toUpperCase()],
      },
    }),
    null,
  );
  // No directory entry, or non-allowlist policies → unknown, no warning.
  assert.equal(
    memberLeaderWarning({ ...base, directoryEntry: undefined }),
    null,
  );
  assert.equal(
    memberLeaderWarning({
      ...base,
      directoryEntry: { respondTo: "anyone", respondToAllowlist: [] },
    }),
    null,
  );
});

test("memberLeaderWarning never fires for same-owner members or without a leader", () => {
  const excluding = { respondTo: "allowlist", respondToAllowlist: [] };
  assert.equal(
    memberLeaderWarning({
      directoryEntry: excluding,
      leaderPubkey: A,
      memberOwnerPubkey: B,
      viewerPubkey: B,
    }),
    null,
  );
  assert.equal(
    memberLeaderWarning({
      directoryEntry: excluding,
      leaderPubkey: "",
      memberOwnerPubkey: C,
      viewerPubkey: B,
    }),
    null,
  );
});

// ── naming ───────────────────────────────────────────────────────────────

test("swarmDisplayName prefers the stored name, falls back to {Leader}'s swarm", () => {
  assert.equal(defaultSwarmName("Beeatrice"), "Beeatrice's swarm");
  assert.equal(swarmDisplayName("Build crew", "Beeatrice"), "Build crew");
  assert.equal(swarmDisplayName("   ", "Beeatrice"), "Beeatrice's swarm");
});

test("combineSwarmAgentOptions: distinct same-name agents stay separate options", () => {
  // Upstream #5202: agent identity is the pubkey, not the display name — an
  // owner may intentionally run multiple same-named agents, and collapsing
  // them made one unpickable as a swarm member.
  const OWNER = "f".repeat(64);
  const options = combineSwarmAgentOptions(
    [{ pubkey: "1".repeat(64), name: "Fizz", avatarUrl: "managed.png" }],
    [
      {
        pubkey: "2".repeat(64),
        displayName: "Fizz",
        nip05Handle: null,
        avatarUrl: "old-fizz.png",
        ownerPubkey: OWNER,
      },
      {
        pubkey: "3".repeat(64),
        displayName: "Bumble",
        nip05Handle: null,
        avatarUrl: null,
        ownerPubkey: OWNER,
      },
    ],
    { currentPubkey: OWNER },
  );

  const labels = options.map((option) => option.label);
  assert.deepEqual(labels, ["Bumble", "Fizz", "Fizz"]);
  const fizzPubkeys = options
    .filter((option) => option.label === "Fizz")
    .map((option) => option.pubkey)
    .sort();
  assert.deepEqual(fizzPubkeys, ["1".repeat(64), "2".repeat(64)]);
});

test("combineSwarmAgentOptions: cross-owner same names stay separate", () => {
  const options = combineSwarmAgentOptions(
    [],
    [
      {
        pubkey: "4".repeat(64),
        displayName: "Hermes",
        nip05Handle: null,
        avatarUrl: null,
        ownerPubkey: "a".repeat(64),
      },
      {
        pubkey: "5".repeat(64),
        displayName: "Hermes",
        nip05Handle: null,
        avatarUrl: null,
        ownerPubkey: "b".repeat(64),
      },
    ],
    { currentPubkey: "a".repeat(64) },
  );

  assert.equal(options.length, 2);
});
