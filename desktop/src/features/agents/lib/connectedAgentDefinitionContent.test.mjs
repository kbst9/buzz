import assert from "node:assert/strict";
import test from "node:test";

import { parseConnectedAgentDefinition } from "./connectedAgentDefinitionContent.ts";

test("parses a minimal connected-agent definition", () => {
  const parsed = parseConnectedAgentDefinition(
    JSON.stringify({ name: "Claude", system_prompt: "You are Claude." }),
  );
  assert.equal(parsed.name, "Claude");
  assert.equal(parsed.instructions, "You are Claude.");
});

test("tolerates the full managed-agent projection", () => {
  const parsed = parseConnectedAgentDefinition(
    JSON.stringify({
      name: "Bumble",
      persona_id: "builtin:bumble",
      system_prompt: "You are Bumble.",
      parallelism: 24,
      respond_to: "allowlist",
      respond_to_allowlist: ["8d58ccc3"],
    }),
  );
  assert.equal(parsed.name, "Bumble");
  assert.equal(parsed.instructions, "You are Bumble.");
});

test("a definition without a prompt yields empty instructions", () => {
  const parsed = parseConnectedAgentDefinition(
    JSON.stringify({ name: "Looper", persona_id: "db70d996" }),
  );
  assert.equal(parsed.name, "Looper");
  assert.equal(parsed.instructions, "");
});

test("missing, malformed, and non-object content edit like an absent definition", () => {
  for (const content of [
    null,
    undefined,
    "",
    "not json",
    '"a string"',
    "[1,2]",
    JSON.stringify({ name: 42, system_prompt: { nested: true } }),
  ]) {
    const parsed = parseConnectedAgentDefinition(content);
    assert.equal(parsed.instructions, "", `content: ${String(content)}`);
  }
  // Blank names normalize to null so the editor falls back to the
  // directory label.
  assert.equal(
    parseConnectedAgentDefinition(JSON.stringify({ name: "  " })).name,
    null,
  );
});
