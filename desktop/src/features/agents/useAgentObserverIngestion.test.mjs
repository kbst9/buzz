import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectSeenOwnedAgentPubkeys,
  combineObserverIngestionAgents,
} from "./useAgentObserverIngestion.ts";

const ME = "aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234";
const OTHER =
  "bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321";
const AGENT_LOCAL =
  "cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111";
const AGENT_REMOTE =
  "dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222";
const AGENT_FOREIGN =
  "eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333";

describe("combineObserverIngestionAgents", () => {
  it("keeps managed agents with their real status", () => {
    const result = combineObserverIngestionAgents(
      [{ pubkey: AGENT_LOCAL, status: "running" }],
      [],
      new Map(),
      ME,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_LOCAL, status: "running" }]);
  });

  it("adds declared-owned relay agents as deployed", () => {
    const result = combineObserverIngestionAgents(
      [],
      [AGENT_REMOTE],
      new Map([[AGENT_REMOTE, ME]]),
      ME,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_REMOTE, status: "deployed" }]);
  });

  it("excludes relay agents owned by someone else", () => {
    const result = combineObserverIngestionAgents(
      [],
      [AGENT_FOREIGN],
      new Map([[AGENT_FOREIGN, OTHER]]),
      ME,
    );
    assert.deepEqual(result, []);
  });

  it("excludes relay agents with no declared owner", () => {
    const result = combineObserverIngestionAgents(
      [],
      [AGENT_REMOTE],
      new Map(),
      ME,
    );
    assert.deepEqual(result, []);
  });

  it("does not duplicate an agent that is both managed and on the relay", () => {
    const result = combineObserverIngestionAgents(
      [{ pubkey: AGENT_LOCAL, status: "stopped" }],
      [AGENT_LOCAL],
      new Map([[AGENT_LOCAL, ME]]),
      ME,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_LOCAL, status: "stopped" }]);
  });

  it("matches ownership case-insensitively", () => {
    const result = combineObserverIngestionAgents(
      [],
      [AGENT_REMOTE.toUpperCase()],
      new Map([[AGENT_REMOTE, ME.toUpperCase()]]),
      ME,
    );
    assert.deepEqual(result, [
      { pubkey: AGENT_REMOTE.toUpperCase(), status: "deployed" },
    ]);
  });

  it("returns only managed agents when identity is not resolved yet", () => {
    const result = combineObserverIngestionAgents(
      [{ pubkey: AGENT_LOCAL, status: "running" }],
      [AGENT_REMOTE],
      new Map([[AGENT_REMOTE, ME]]),
      undefined,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_LOCAL, status: "running" }]);
  });
});

describe("collectSeenOwnedAgentPubkeys", () => {
  const entry = (pubkey, value) => [["users-batch-entry", pubkey], value];

  it("collects owned agents from the wrapped cache entry shape", () => {
    // The cache stores { summary, fetchedAt } wrappers — reading the bare
    // summary shape regressed the entire observer widening to a no-op once.
    const entries = [
      entry(AGENT_REMOTE, {
        summary: { displayName: "Codex", isAgent: true, ownerPubkey: ME },
        fetchedAt: 123,
      }),
      entry(AGENT_LOCAL.toUpperCase(), {
        summary: {
          displayName: "Hermes",
          isAgent: true,
          ownerPubkey: ME.toUpperCase(),
        },
        fetchedAt: 123,
      }),
      entry(AGENT_FOREIGN, {
        summary: { displayName: "Mira", isAgent: true, ownerPubkey: OTHER },
        fetchedAt: 123,
      }),
    ];

    assert.deepEqual(
      collectSeenOwnedAgentPubkeys(entries, ME),
      [AGENT_LOCAL, AGENT_REMOTE].sort(),
    );
  });

  it("ignores misses, ownerless summaries, and malformed keys", () => {
    const entries = [
      entry(AGENT_REMOTE, { summary: null, fetchedAt: 1 }),
      entry(AGENT_LOCAL, { summary: { displayName: "x", ownerPubkey: null } }),
      entry(AGENT_FOREIGN, undefined),
      [["users-batch-entry"], { summary: { ownerPubkey: ME } }],
    ];

    assert.deepEqual(collectSeenOwnedAgentPubkeys(entries, ME), []);
  });
});
