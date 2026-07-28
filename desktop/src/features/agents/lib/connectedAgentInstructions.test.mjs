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

test("add instructions embed relay url and owner pubkey, never ask for the owner secret", () => {
  const text = buildAddAgentInstructions({
    relayUrl: "wss://buzz.example.org",
    ownerPubkey: "a".repeat(64),
  });
  assert.ok(text.includes("wss://buzz.example.org"));
  assert.ok(text.includes("a".repeat(64)));
  assert.ok(text.includes("never ask for"));
  assert.ok(text.includes("compute_auth_tag"));
  assert.ok(text.includes("new-standalone-agent.sh"));
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
});

test("edit instructions shell-quote values with apostrophes", () => {
  const text = buildEditAgentInstructions({
    agentName: "Codex",
    about: "it's helpful",
  });
  assert.ok(text.includes(`--about 'it'\\''s helpful'`));
  assert.ok(text.includes("BUZZ_ACP_PROFILE_ABOUT=it's helpful"));
});
