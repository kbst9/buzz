import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveProfileChannels,
  parseProfilePanelTab,
  parseProfilePanelView,
  personaManagedAgentUpdate,
  profilePanelTabFromSearch,
  profilePanelViewFromSearch,
} from "./UserProfilePanelUtils.ts";

function agent(overrides = {}) {
  return {
    pubkey: "deadbeef".repeat(8),
    name: "Fizz",
    personaId: "persona-1",
    relayUrl: "ws://localhost:3000",
    acpCommand: "buzz-acp",
    agentCommand: "goose",
    agentArgs: [],
    mcpCommand: "",
    turnTimeoutSeconds: 320,
    idleTimeoutSeconds: null,
    maxTurnDurationSeconds: null,
    parallelism: 1,
    systemPrompt: "Old prompt",
    avatarUrl: "app-avatar://old",
    model: "old-model",
    envVars: { OLD_KEY: "1" },
    status: "stopped",
    pid: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastStartedAt: null,
    lastStoppedAt: null,
    lastExitCode: null,
    lastError: null,
    logPath: null,
    startOnAppLaunch: true,
    backend: { type: "local" },
    backendAgentId: null,
    respondTo: "owner-only",
    respondToAllowlist: [],
    ...overrides,
  };
}

function persona(overrides = {}) {
  return {
    id: "persona-1",
    displayName: "Fizz Prime",
    avatarUrl: null,
    systemPrompt: "New prompt",
    runtime: "goose",
    model: "new-model",
    provider: null,
    namePool: [],
    isBuiltIn: false,
    isActive: true,
    envVars: { NEW_KEY: "2" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function runtime(overrides = {}) {
  return {
    id: "claude",
    label: "Claude Code",
    avatarUrl: "app-avatar://claude",
    availability: "available",
    command: "claude",
    binaryPath: "/usr/local/bin/claude",
    defaultArgs: ["mcp", "serve"],
    mcpCommand: "claude-mcp",
    installHint: "",
    installInstructionsUrl: "",
    canAutoInstall: false,
    underlyingCliPath: null,
    ...overrides,
  };
}

function channel(overrides = {}) {
  return {
    id: "chan-1",
    name: "general",
    channelType: "stream",
    visibility: "open",
    description: "",
    topic: null,
    purpose: null,
    memberCount: 0,
    memberPubkeys: [],
    lastMessageAt: null,
    archivedAt: null,
    participants: [],
    participantPubkeys: [],
    isMember: true,
    ttlSeconds: null,
    ttlDeadline: null,
    ...overrides,
  };
}

test("deriveProfileChannels lists memberships for a connected agent (bot, no managed record)", () => {
  const agentPubkey = "ab".repeat(32);
  const channels = [
    channel({
      id: "c1",
      name: "general",
      memberPubkeys: [agentPubkey.toUpperCase(), "cd".repeat(32)],
    }),
    channel({ id: "c2", name: "random", memberPubkeys: [agentPubkey] }),
    channel({ id: "c3", name: "quiet", memberPubkeys: ["cd".repeat(32)] }),
  ];

  assert.deepEqual(
    deriveProfileChannels(agentPubkey, undefined, undefined, channels, true),
    [
      { id: "c1", name: "general" },
      { id: "c2", name: "random" },
    ],
  );
});

test("deriveProfileChannels leaves human profiles unchanged (no membership scan)", () => {
  const humanPubkey = "cd".repeat(32);
  const channels = [
    channel({ id: "c1", name: "general", memberPubkeys: [humanPubkey] }),
  ];

  assert.deepEqual(
    deriveProfileChannels(humanPubkey, undefined, undefined, channels),
    [],
  );
  assert.deepEqual(
    deriveProfileChannels(humanPubkey, undefined, undefined, channels, false),
    [],
  );
});

test("deriveProfileChannels still scans memberships for managed agents", () => {
  const managedPubkey = "deadbeef".repeat(8);
  const channels = [
    channel({ id: "c1", name: "general", memberPubkeys: [managedPubkey] }),
  ];

  assert.deepEqual(
    deriveProfileChannels(managedPubkey, undefined, agent(), channels, true),
    [{ id: "c1", name: "general" }],
  );
});

test("personaManagedAgentUpdate syncs edited persona identity to linked agent", () => {
  assert.deepEqual(personaManagedAgentUpdate(agent(), persona()), {
    pubkey: "deadbeef".repeat(8),
    name: "Fizz Prime",
    systemPrompt: "New prompt",
    model: "new-model",
    envVars: { NEW_KEY: "2" },
  });
});

test("personaManagedAgentUpdate skips unrelated or unchanged agents", () => {
  assert.equal(
    personaManagedAgentUpdate(agent({ personaId: "persona-2" }), persona()),
    null,
  );
  assert.equal(
    personaManagedAgentUpdate(
      agent({
        name: "Fizz Prime",
        avatarUrl: null,
        systemPrompt: "New prompt",
        model: "new-model",
        envVars: { NEW_KEY: "2" },
      }),
      persona(),
    ),
    null,
  );
});

test("personaManagedAgentUpdate maps changed persona runtime to linked agent commands", () => {
  assert.deepEqual(
    personaManagedAgentUpdate(agent(), persona({ runtime: "claude" }), {
      previousPersona: persona({ runtime: "goose" }),
      runtimes: [runtime()],
    }),
    {
      pubkey: "deadbeef".repeat(8),
      name: "Fizz Prime",
      systemPrompt: "New prompt",
      model: "new-model",
      envVars: { NEW_KEY: "2" },
      agentCommand: "claude",
      agentArgs: ["mcp", "serve"],
      mcpCommand: "claude-mcp",
    },
  );
});

test("personaManagedAgentUpdate leaves runtime fields alone when runtime is unchanged", () => {
  assert.equal(
    personaManagedAgentUpdate(
      agent({
        name: "Fizz Prime",
        avatarUrl: null,
        systemPrompt: "New prompt",
        model: "new-model",
        envVars: { NEW_KEY: "2" },
        agentArgs: ["custom"],
      }),
      persona({ runtime: "goose" }),
      {
        previousPersona: persona({ runtime: "goose" }),
        runtimes: [runtime({ id: "goose", command: "goose" })],
      },
    ),
    null,
  );
});

test("parseProfilePanelView accepts all profile panel subviews", () => {
  for (const view of [
    "summary",
    "info",
    "configuration",
    "diagnostics",
    "memories",
    "channels",
    "logs",
  ]) {
    assert.equal(parseProfilePanelView(view), view);
  }
});

test("parseProfilePanelView maps legacy agent config subviews to configuration", () => {
  for (const view of ["model", "settings"]) {
    assert.equal(parseProfilePanelView(view), "configuration");
  }
});

test("profilePanelViewFromSearch falls back to summary for invalid values", () => {
  assert.equal(parseProfilePanelView("missing"), null);
  assert.equal(profilePanelViewFromSearch("missing"), "summary");
  assert.equal(profilePanelViewFromSearch(null), "summary");
});

test("parseProfilePanelTab accepts profile summary tabs", () => {
  for (const tab of ["info", "runtime", "channels", "memories"]) {
    assert.equal(parseProfilePanelTab(tab), tab);
  }
});

test("profilePanelTabFromSearch falls back to info for invalid values", () => {
  assert.equal(parseProfilePanelTab("missing"), null);
  assert.equal(profilePanelTabFromSearch("missing"), "info");
  assert.equal(profilePanelTabFromSearch(null), "info");
});
