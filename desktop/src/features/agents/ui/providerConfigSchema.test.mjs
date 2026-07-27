import assert from "node:assert/strict";
import test from "node:test";

import { enumOptionsFor, needsBlankOption } from "./providerConfigSchema.ts";

test("properties without an enum stay free-text", () => {
  assert.equal(enumOptionsFor({ type: "string" }, ""), null);
  assert.equal(enumOptionsFor({ enum: [] }, ""), null);
  // Non-string entries are not renderable as options.
  assert.equal(enumOptionsFor({ enum: [1, 2] }, ""), null);
});

test("enum properties render their options", () => {
  assert.deepEqual(enumOptionsFor({ enum: ["claude", "codex"] }, "codex"), [
    "claude",
    "codex",
  ]);
});

test("an unrecognised saved value is preserved, not silently rewritten", () => {
  // An agent configured for a runtime that was later uninstalled must still
  // show its real destination rather than jumping to the first option.
  assert.deepEqual(enumOptionsFor({ enum: ["claude"] }, "hermes"), [
    "hermes",
    "claude",
  ]);
});

test("blank option appears only when the value is not a valid choice", () => {
  assert.equal(needsBlankOption("", ["claude"]), true);
  assert.equal(needsBlankOption("claude", ["claude"]), false);
});
