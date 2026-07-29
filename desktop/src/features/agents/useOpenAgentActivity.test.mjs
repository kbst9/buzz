import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectAgentMemberChannelIds,
  isChannelOpenable,
  resolveOpenableActivityChannelId,
} from "./useOpenAgentActivity.ts";

describe("isChannelOpenable", () => {
  it("allows joined channels regardless of visibility", () => {
    assert.equal(
      isChannelOpenable({ isMember: true, visibility: "private" }),
      true,
    );
    assert.equal(
      isChannelOpenable({ isMember: true, visibility: "open" }),
      true,
    );
  });

  it("allows open channels the viewer hasn't joined (read-only)", () => {
    assert.equal(
      isChannelOpenable({ isMember: false, visibility: "open" }),
      true,
    );
  });

  it("rejects private channels the viewer hasn't joined", () => {
    assert.equal(
      isChannelOpenable({ isMember: false, visibility: "private" }),
      false,
    );
  });

  it("rejects channels missing from the viewer's channel list", () => {
    assert.equal(isChannelOpenable(undefined), false);
  });
});

describe("collectAgentMemberChannelIds", () => {
  const agentPubkey = "ab".repeat(32);

  it("collects channels listing the agent as a member, case-insensitively", () => {
    const channels = [
      {
        id: "chan-1",
        memberPubkeys: [agentPubkey.toUpperCase(), "cd".repeat(32)],
      },
      { id: "chan-2", memberPubkeys: ["cd".repeat(32)] },
      { id: "chan-3", memberPubkeys: [agentPubkey] },
    ];

    assert.deepEqual(collectAgentMemberChannelIds(channels, agentPubkey), [
      "chan-1",
      "chan-3",
    ]);
  });

  it("returns empty for undefined channels and non-members", () => {
    assert.deepEqual(collectAgentMemberChannelIds(undefined, agentPubkey), []);
    assert.deepEqual(
      collectAgentMemberChannelIds(
        [{ id: "chan-1", memberPubkeys: [] }],
        agentPubkey,
      ),
      [],
    );
  });

  it("resolves the member channel for an idle connected agent (no directory entry, no working state)", () => {
    // Mirrors resolveChannelId for a connected agent: no kind:10100 entry
    // (agentChannelIds from membership only) and no working channels — the
    // membership-derived channel must resolve, so canOpenAgentActivity
    // (resolveChannelId !== null) holds.
    const channels = [
      {
        id: "chan-1",
        isMember: true,
        visibility: "private",
        memberPubkeys: [agentPubkey],
      },
    ];
    const resolved = resolveOpenableActivityChannelId({
      agentChannelIds: collectAgentMemberChannelIds(channels, agentPubkey),
      openableChannelIds: new Set(
        channels
          .filter((channel) => isChannelOpenable(channel))
          .map((channel) => channel.id),
      ),
      workingChannelIds: [],
    });

    assert.notEqual(resolved, null);
    assert.equal(resolved, "chan-1");
  });
});

describe("resolveOpenableActivityChannelId", () => {
  it("prefers the first openable working channel", () => {
    assert.equal(
      resolveOpenableActivityChannelId({
        agentChannelIds: ["member-1"],
        openableChannelIds: new Set(["working-2", "member-1"]),
        workingChannelIds: ["working-1", "working-2"],
      }),
      "working-2",
    );
  });

  it("falls back to the agent's first openable member channel", () => {
    assert.equal(
      resolveOpenableActivityChannelId({
        agentChannelIds: ["hidden-2", "member-1"],
        openableChannelIds: new Set(["member-1"]),
        workingChannelIds: ["hidden-1"],
      }),
      "member-1",
    );
  });

  it("returns null when the agent is only active in inaccessible rooms", () => {
    assert.equal(
      resolveOpenableActivityChannelId({
        agentChannelIds: ["hidden-2"],
        openableChannelIds: new Set(["unrelated"]),
        workingChannelIds: ["hidden-1"],
      }),
      null,
    );
  });

  it("returns null with no candidate channels at all", () => {
    assert.equal(
      resolveOpenableActivityChannelId({
        agentChannelIds: [],
        openableChannelIds: new Set(),
        workingChannelIds: [],
      }),
      null,
    );
  });
});
