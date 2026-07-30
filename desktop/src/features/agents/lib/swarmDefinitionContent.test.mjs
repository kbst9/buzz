import assert from "node:assert/strict";
import test from "node:test";

import {
  mapSwarmEventsToDefinitions,
  parseSwarmContent,
  selectSwarmDefinitionHeads,
  serializeSwarmContent,
  swarmEventId,
} from "./swarmDefinitionContent.ts";

const LEADER = "a".repeat(64);
const MEMBER = "b".repeat(64);

function fullContent() {
  return JSON.stringify({
    name: "Build crew",
    leader_pubkey: LEADER,
    instructions: "Prioritize small diffs.",
    members: [{ pubkey: MEMBER, description: "do bug fixes" }],
    report_back: true,
    evaluation_criteria: "Tests pass.",
  });
}

// ── parseSwarmContent ────────────────────────────────────────────────────

test("parses a full swarm definition with the SDK's snake_case field names", () => {
  const parsed = parseSwarmContent("swarm-1", fullContent());
  assert.deepEqual(parsed, {
    id: "swarm-1",
    name: "Build crew",
    leaderPubkey: LEADER,
    instructions: "Prioritize small diffs.",
    members: [{ pubkey: MEMBER, description: "do bug fixes" }],
    reportBack: true,
    evaluationCriteria: "Tests pass.",
  });
});

test("missing, malformed, and non-object content parse as an empty definition", () => {
  for (const content of [null, undefined, "", "not json", "[1,2]", "42"]) {
    const parsed = parseSwarmContent("swarm-1", content);
    assert.equal(parsed.id, "swarm-1");
    assert.equal(parsed.name, "");
    assert.equal(parsed.leaderPubkey, "");
    assert.deepEqual(parsed.members, []);
    assert.equal(parsed.reportBack, false);
    assert.equal(parsed.evaluationCriteria, "");
  }
});

test("tolerates absent fields (never-wipe partial writer) and unknown fields", () => {
  const parsed = parseSwarmContent(
    "swarm-1",
    JSON.stringify({ name: "Renamed", future_field: { nested: 1 } }),
  );
  assert.equal(parsed.name, "Renamed");
  assert.equal(parsed.leaderPubkey, "");
  assert.deepEqual(parsed.members, []);
});

test("normalizes pubkeys to lowercase and drops member entries without one", () => {
  const parsed = parseSwarmContent(
    "swarm-1",
    JSON.stringify({
      leader_pubkey: LEADER.toUpperCase(),
      members: [
        { pubkey: MEMBER.toUpperCase(), description: "x" },
        { description: "no pubkey" },
        "not an object",
        { pubkey: 42 },
      ],
    }),
  );
  assert.equal(parsed.leaderPubkey, LEADER);
  assert.deepEqual(parsed.members, [{ pubkey: MEMBER, description: "x" }]);
});

test("non-string member description parses as empty string", () => {
  const parsed = parseSwarmContent(
    "swarm-1",
    JSON.stringify({ members: [{ pubkey: MEMBER, description: 7 }] }),
  );
  assert.deepEqual(parsed.members, [{ pubkey: MEMBER, description: "" }]);
});

test("report_back must be boolean true — truthy strings do not count", () => {
  const parsed = parseSwarmContent(
    "swarm-1",
    JSON.stringify({ report_back: "true" }),
  );
  assert.equal(parsed.reportBack, false);
});

// ── serializeSwarmContent ────────────────────────────────────────────────

test("serialize emits exactly the SDK field names and round-trips", () => {
  const definition = {
    name: "Build crew",
    leaderPubkey: LEADER,
    instructions: "Prioritize small diffs.",
    members: [{ pubkey: MEMBER, description: "do bug fixes" }],
    reportBack: true,
    evaluationCriteria: "Tests pass.",
  };
  const body = JSON.parse(serializeSwarmContent(definition));
  assert.deepEqual(Object.keys(body).sort(), [
    "evaluation_criteria",
    "instructions",
    "leader_pubkey",
    "members",
    "name",
    "report_back",
  ]);
  assert.deepEqual(body.members, [
    { pubkey: MEMBER, description: "do bug fixes" },
  ]);
  assert.equal(body.report_back, true);

  const reparsed = parseSwarmContent(
    "swarm-1",
    serializeSwarmContent(definition),
  );
  assert.deepEqual(reparsed, { id: "swarm-1", ...definition });
});

test("serialize lowercases pubkeys and drops empty member rows", () => {
  const body = JSON.parse(
    serializeSwarmContent({
      name: "",
      leaderPubkey: ` ${LEADER.toUpperCase()} `,
      instructions: "",
      members: [
        { pubkey: "", description: "empty row" },
        { pubkey: MEMBER.toUpperCase(), description: "" },
      ],
      reportBack: false,
      evaluationCriteria: "kept while toggle off",
    }),
  );
  assert.equal(body.leader_pubkey, LEADER);
  assert.deepEqual(body.members, [{ pubkey: MEMBER, description: "" }]);
  // The criteria value is retained even while reporting is off (§6).
  assert.equal(body.evaluation_criteria, "kept while toggle off");
});

// ── NIP-33 head selection ────────────────────────────────────────────────

function event(id, swarmId, createdAt, content = "{}") {
  return { id, created_at: createdAt, content, tags: [["d", swarmId]] };
}

test("selectSwarmDefinitionHeads keeps the newest event per d-tag", () => {
  const heads = selectSwarmDefinitionHeads([
    event("e1", "s1", 100),
    event("e2", "s1", 200),
    event("e3", "s2", 50),
  ]);
  assert.deepEqual(heads.map((head) => head.id).sort(), ["e2", "e3"]);
});

test("created_at ties break to the lowest event id (NIP-01 rule)", () => {
  const heads = selectSwarmDefinitionHeads([
    event("ff", "s1", 100),
    event("aa", "s1", 100),
  ]);
  assert.equal(heads[0].id, "aa");
});

test("events without a d-tag are skipped", () => {
  const heads = selectSwarmDefinitionHeads([
    { id: "e1", created_at: 1, content: "{}", tags: [] },
    { id: "e2", created_at: 1, content: "{}", tags: [["d", ""]] },
  ]);
  assert.deepEqual(heads, []);
  assert.equal(
    swarmEventId({ id: "e1", created_at: 1, content: "{}", tags: [] }),
    null,
  );
});

test("mapSwarmEventsToDefinitions parses heads and sorts named-first", () => {
  const definitions = mapSwarmEventsToDefinitions([
    event("e1", "s-unnamed", 100, "{}"),
    event("e2", "s-old", 100, JSON.stringify({ name: "Old name" })),
    event("e3", "s-old", 200, JSON.stringify({ name: "Zulu crew" })),
    event("e4", "s-alpha", 100, JSON.stringify({ name: "Alpha crew" })),
  ]);
  assert.deepEqual(
    definitions.map((definition) => [definition.id, definition.name]),
    [
      ["s-alpha", "Alpha crew"],
      ["s-old", "Zulu crew"],
      ["s-unnamed", ""],
    ],
  );
});
