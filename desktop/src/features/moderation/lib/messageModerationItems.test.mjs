import assert from "node:assert/strict";
import test from "node:test";

import { resolveMessageModerationItems } from "./messageModerationItems.ts";

/** Moderator viewing a human-authored message inside a channel. */
const BASE = {
  authorIsAgent: false,
  canModerate: true,
  hasChannel: true,
  hasTarget: true,
  isSelf: false,
};

test("moderator gets restrict and kick for a human author in a channel", () => {
  assert.deepEqual(resolveMessageModerationItems(BASE), {
    kick: true,
    restrict: true,
  });
});

test("agent author: ban/timeout withheld, kick still offered", () => {
  assert.deepEqual(
    resolveMessageModerationItems({ ...BASE, authorIsAgent: true }),
    { kick: true, restrict: false },
  );
});

test("agent author outside a channel: no entries at all", () => {
  assert.deepEqual(
    resolveMessageModerationItems({
      ...BASE,
      authorIsAgent: true,
      hasChannel: false,
    }),
    { kick: false, restrict: false },
  );
});

test("human author outside a channel keeps restriction entries only", () => {
  assert.deepEqual(
    resolveMessageModerationItems({ ...BASE, hasChannel: false }),
    { kick: false, restrict: true },
  );
});

test("non-moderator gets nothing, even for a human author", () => {
  assert.deepEqual(
    resolveMessageModerationItems({ ...BASE, canModerate: false }),
    { kick: false, restrict: false },
  );
});

test("self-authored message gets nothing", () => {
  assert.deepEqual(resolveMessageModerationItems({ ...BASE, isSelf: true }), {
    kick: false,
    restrict: false,
  });
});

test("message without a real signer gets nothing", () => {
  assert.deepEqual(
    resolveMessageModerationItems({ ...BASE, hasTarget: false }),
    { kick: false, restrict: false },
  );
});
