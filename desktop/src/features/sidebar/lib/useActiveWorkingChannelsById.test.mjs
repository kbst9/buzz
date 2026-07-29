import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveActiveWorkingChannelNames } from "./useActiveWorkingChannelsById.ts";

describe("resolveActiveWorkingChannelNames", () => {
  it("resolves active agent pubkeys to managed agent names", () => {
    const resolved = resolveActiveWorkingChannelNames(
      {
        channelId: "chan-1",
        anchorAt: 0,
        agentCount: 2,
        agentPubkeys: ["AAAA", "bbbb"],
      },
      [
        { pubkey: "aaaa", name: "Ned" },
        { pubkey: "BBBB", name: "Bart" },
      ],
    );

    assert.deepEqual(resolved.agentNames, ["Ned", "Bart"]);
  });

  it("omits unresolved active agents from the resolved names", () => {
    const resolved = resolveActiveWorkingChannelNames(
      {
        channelId: "chan-1",
        anchorAt: 0,
        agentCount: 2,
        agentPubkeys: ["AAAA", "cccc"],
      },
      [{ pubkey: "aaaa", name: "Ned" }],
    );

    assert.deepEqual(resolved.agentNames, ["Ned"]);
  });

  it("falls back to profile names for non-managed agents", () => {
    const resolved = resolveActiveWorkingChannelNames(
      {
        channelId: "chan-1",
        anchorAt: 0,
        agentCount: 2,
        agentPubkeys: ["AAAA", "CCCC"],
      },
      [{ pubkey: "aaaa", name: "Ned" }],
      new Map([["cccc", "Connie"]]),
    );

    assert.deepEqual(resolved.agentNames, ["Ned", "Connie"]);
  });

  it("prefers the managed agent name over a profile fallback", () => {
    const resolved = resolveActiveWorkingChannelNames(
      {
        channelId: "chan-1",
        anchorAt: 0,
        agentCount: 1,
        agentPubkeys: ["aaaa"],
      },
      [{ pubkey: "AAAA", name: "Ned" }],
      new Map([["aaaa", "Profile Ned"]]),
    );

    assert.deepEqual(resolved.agentNames, ["Ned"]);
  });

  it("omits pubkeys unresolved by both managed agents and profiles", () => {
    const resolved = resolveActiveWorkingChannelNames(
      {
        channelId: "chan-1",
        anchorAt: 0,
        agentCount: 3,
        agentPubkeys: ["aaaa", "cccc", "dddd"],
      },
      [{ pubkey: "aaaa", name: "Ned" }],
      new Map([["cccc", "Connie"]]),
    );

    assert.deepEqual(resolved.agentNames, ["Ned", "Connie"]);
  });

  it("resolves entirely unnamed summaries to an empty list without crashing", () => {
    const resolved = resolveActiveWorkingChannelNames(
      {
        channelId: "chan-1",
        anchorAt: 0,
        agentCount: 1,
        agentPubkeys: ["dddd"],
      },
      [],
      new Map(),
    );

    assert.deepEqual(resolved.agentNames, []);
    assert.equal(resolved.agentCount, 1);
  });
});
