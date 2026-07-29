import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentSessionReturnTarget } from "./agentSessionSelection.ts";

test("returns the open thread when activity opens over a thread", () => {
  assert.deepEqual(
    resolveAgentSessionReturnTarget({
      openThreadHeadId: "head-1",
      profilePanelPubkey: null,
    }),
    { kind: "thread", threadHeadId: "head-1" },
  );
});

test("returns the profile when activity opens over the profile panel", () => {
  assert.deepEqual(
    resolveAgentSessionReturnTarget({
      openThreadHeadId: null,
      profilePanelPubkey: "abc",
    }),
    { kind: "profile", pubkey: "abc" },
  );
});

test("prefers the thread when both params linger, matching pane priority", () => {
  assert.deepEqual(
    resolveAgentSessionReturnTarget({
      openThreadHeadId: "head-1",
      profilePanelPubkey: "abc",
    }),
    { kind: "thread", threadHeadId: "head-1" },
  );
});

test("returns null when activity opens over no pane", () => {
  assert.equal(
    resolveAgentSessionReturnTarget({
      openThreadHeadId: null,
      profilePanelPubkey: null,
    }),
    null,
  );
});

const OWNER = "a".repeat(64);
const AGENT = "b".repeat(64);

function memberBotAgent(overrides = {}) {
  return {
    pubkey: AGENT,
    name: "Nova",
    status: "deployed",
    agentSource: "member-bot",
    canInterruptTurn: false,
    ...overrides,
  };
}

test("listed connected agent gains canInterruptTurn for its verified owner", async () => {
  const { resolveSelectedAgentSession } = await import(
    "./agentSessionSelection.ts"
  );
  const resolved = resolveSelectedAgentSession({
    agentSessionAgents: [memberBotAgent()],
    currentPubkey: OWNER,
    openAgentSessionPubkey: AGENT,
    profiles: { [AGENT]: { ownerPubkey: OWNER } },
  });

  assert.equal(resolved?.canInterruptTurn, true);
  assert.equal(resolved?.agentSource, "member-bot");
});

test("listed connected agent stays non-interruptible for non-owners", async () => {
  const { resolveSelectedAgentSession } = await import(
    "./agentSessionSelection.ts"
  );
  const resolved = resolveSelectedAgentSession({
    agentSessionAgents: [memberBotAgent()],
    currentPubkey: "c".repeat(64),
    openAgentSessionPubkey: AGENT,
    profiles: { [AGENT]: { ownerPubkey: OWNER } },
  });

  assert.equal(resolved?.canInterruptTurn, false);
});

test("profile-panel fallback agent is interruptible only when viewer-owned", async () => {
  const { resolveSelectedAgentSession } = await import(
    "./agentSessionSelection.ts"
  );
  const owned = resolveSelectedAgentSession({
    agentSessionAgents: [],
    currentPubkey: OWNER,
    openAgentSessionPubkey: AGENT,
    profilePanelPubkey: AGENT,
    profiles: { [AGENT]: { ownerPubkey: OWNER.toUpperCase() } },
  });
  const foreign = resolveSelectedAgentSession({
    agentSessionAgents: [],
    currentPubkey: "c".repeat(64),
    openAgentSessionPubkey: AGENT,
    profilePanelPubkey: AGENT,
    profiles: { [AGENT]: { ownerPubkey: OWNER } },
  });

  assert.equal(owned?.canInterruptTurn, true);
  assert.equal(foreign?.canInterruptTurn, false);
});

test("managed agents keep canInterruptTurn without profile data", async () => {
  const { resolveSelectedAgentSession } = await import(
    "./agentSessionSelection.ts"
  );
  const resolved = resolveSelectedAgentSession({
    agentSessionAgents: [
      memberBotAgent({ agentSource: "managed", canInterruptTurn: true }),
    ],
    openAgentSessionPubkey: AGENT,
  });

  assert.equal(resolved?.canInterruptTurn, true);
});
