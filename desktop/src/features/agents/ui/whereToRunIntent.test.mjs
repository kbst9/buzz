import assert from "node:assert/strict";
import test from "node:test";

import {
  canSubmitWhereToRun,
  emptyWhereToRunDraft,
  providerConfigComplete,
  resolveBackendIntent,
  seedProviderConfigDefaults,
} from "./whereToRunIntent.ts";

const probed = {
  ok: true,
  config_schema: {
    properties: { region: { type: "string" }, size: { type: "integer" } },
    required: ["region"],
  },
};

function providerDraft(overrides = {}) {
  return {
    ...emptyWhereToRunDraft,
    runOn: "blox",
    probedProvider: probed,
    providerConfig: { region: "us", size: "3" },
    ...overrides,
  };
}

test("provider selection blocks submit until the probe completes", () => {
  assert.equal(
    canSubmitWhereToRun(providerDraft({ probedProvider: null })),
    false,
  );
});

test("provider selection blocks submit while required config is missing", () => {
  const missing = providerDraft({ providerConfig: { size: "3" } });
  assert.equal(canSubmitWhereToRun(missing), false);
  assert.equal(providerConfigComplete(missing), false);
});

test("complete provider config allows submit", () => {
  assert.equal(canSubmitWhereToRun(providerDraft()), true);
});

test("local never gates submit", () => {
  assert.equal(canSubmitWhereToRun(emptyWhereToRunDraft), true);
});

test("local draft resolves to null intent", () => {
  assert.equal(resolveBackendIntent(emptyWhereToRunDraft), null);
});

test("provider draft resolves with coerced config values", () => {
  const intent = resolveBackendIntent(providerDraft());
  assert.deepEqual(intent, {
    type: "provider",
    id: "blox",
    config: { region: "us", size: 3 },
  });
});

test("probe defaults seed empty fields without discarding operator input", () => {
  const defaults = { host: "srv", user: "", runtime: "claude" };

  // Fresh selection: defaults populate the form.
  assert.deepEqual(seedProviderConfigDefaults({}, defaults), defaults);

  // A re-probe must not revert what the operator typed. Regression test for the
  // effect that depended on the draft it wrote, which reset every keystroke.
  assert.deepEqual(
    seedProviderConfigDefaults(
      { user: "buzz-codex", runtime: "codex" },
      defaults,
    ),
    { host: "srv", user: "buzz-codex", runtime: "codex" },
  );

  // Empty strings the operator cleared are still their choice, not "unset".
  assert.deepEqual(seedProviderConfigDefaults({ host: "" }, defaults), {
    host: "",
    user: "",
    runtime: "claude",
  });
});
