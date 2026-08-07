import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAddAgentInstructions,
  buildEditAgentInstructions,
  unitSlugForAgentName,
} from "./connectedAgentInstructions.ts";

test("unit slug kebab-cases display names", () => {
  assert.equal(unitSlugForAgentName("Codex"), "codex");
  assert.equal(unitSlugForAgentName("Hermes-G"), "hermes-g");
  assert.equal(unitSlugForAgentName("  My Fancy Agent!  "), "my-fancy-agent");
  assert.equal(unitSlugForAgentName("🐝"), "agent");
});

test("add instructions embed relay url, owner pubkey, and the invite code — no secret handling", () => {
  const text = buildAddAgentInstructions({
    relayUrl: "wss://buzz.example.org",
    ownerPubkey: "a".repeat(64),
    inviteCode: "v2.test-invite-code",
    inviteExpiresAt: 1_754_000_000,
  });
  assert.ok(text.includes("wss://buzz.example.org"));
  assert.ok(text.includes("a".repeat(64)));
  assert.ok(text.includes("v2.test-invite-code"));
  assert.ok(text.includes("single-use"));
  assert.ok(text.includes("expires"));
  assert.ok(text.includes("Never ask for anyone's secret key"));
  assert.ok(text.includes("new-standalone-agent.sh"));
  assert.ok(text.includes("community invite claimed"));
  // The invite flow fully replaces the owner-side tag mint — the old
  // STOP-and-wait step must be gone.
  assert.ok(!text.includes("compute_auth_tag"));
  assert.ok(!text.includes("STOP and ask the owner"));
});

test("add instructions omit the expiry hint when no expiry is known", () => {
  const text = buildAddAgentInstructions({
    relayUrl: "wss://buzz.example.org",
    ownerPubkey: "a".repeat(64),
    inviteCode: "v2.test-invite-code",
  });
  assert.ok(text.includes("v2.test-invite-code (single-use)"));
  assert.ok(!text.includes("expires "));
  assert.ok(!text.includes("Fleet option"));
});

test("add instructions switch to fleet wording for a multi-use budget", () => {
  const text = buildAddAgentInstructions({
    relayUrl: "wss://buzz.example.org",
    ownerPubkey: "a".repeat(64),
    inviteCode: "v2.fleet-code",
    inviteExpiresAt: 1_754_000_000,
    maxUses: 12,
  });
  assert.ok(text.includes("v2.fleet-code (12 uses; expires"));
  assert.ok(!text.includes("single-use"));
  assert.ok(text.includes("Fleet option: this code admits up to 12 agents."));
  assert.ok(text.includes("fleet.toml"));
  assert.ok(text.includes("provision-fleet.ts"));
  // A budget of one keeps the single-use wording untouched.
  const single = buildAddAgentInstructions({
    relayUrl: "wss://buzz.example.org",
    ownerPubkey: "a".repeat(64),
    inviteCode: "v2.solo-code",
    maxUses: 1,
  });
  assert.ok(single.includes("v2.solo-code (single-use)"));
  assert.ok(!single.includes("Fleet option"));
});

test("edit instructions include only the fields that were set", () => {
  const text = buildEditAgentInstructions({
    agentName: "Codex",
    avatarUrl: "https://x.example/codex.png",
  });
  assert.ok(
    text.includes("BUZZ_ACP_PROFILE_AVATAR_URL=https://x.example/codex.png"),
  );
  assert.ok(!text.includes("BUZZ_ACP_PROFILE_NAME="));
  assert.ok(!text.includes("BUZZ_ACP_PROFILE_ABOUT="));
  assert.ok(text.includes("buzz-acp-codex"));
  assert.ok(text.includes("--avatar 'https://x.example/codex.png'"));
  assert.ok(!text.includes("--name"));
  assert.ok(
    !text.includes("bash -c"),
    "flags must not be nested inside another quoting layer",
  );
  assert.ok(text.includes("sudo -i"));
  assert.ok(!text.includes("source /etc/buzz-agents"));
});

test("edit instructions shell-quote values with apostrophes", () => {
  const text = buildEditAgentInstructions({
    agentName: "Codex",
    about: "it's helpful",
  });
  assert.ok(text.includes(`--about 'it'\\''s helpful'`));
  assert.ok(text.includes("BUZZ_ACP_PROFILE_ABOUT=it's helpful"));
});
