import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectOwnedConnectedAgentPubkeys } from "./useObserverIngestionSeed.ts";

const ME = "aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234";
const OTHER =
  "bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321";
const AGENT_OWNED =
  "cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111";
const AGENT_SECOND =
  "dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222";
const AGENT_FOREIGN =
  "eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333";

describe("selectOwnedConnectedAgentPubkeys", () => {
  it("keeps agents owned by the current identity", () => {
    const users = [
      { pubkey: AGENT_OWNED, ownerPubkey: ME, isAgent: true },
      { pubkey: AGENT_SECOND, ownerPubkey: ME, isAgent: true },
    ];

    assert.deepEqual(selectOwnedConnectedAgentPubkeys(users, ME), [
      AGENT_OWNED,
      AGENT_SECOND,
    ]);
  });

  it("drops agents owned by someone else", () => {
    const users = [
      { pubkey: AGENT_FOREIGN, ownerPubkey: OTHER, isAgent: true },
      { pubkey: AGENT_OWNED, ownerPubkey: ME, isAgent: true },
    ];

    assert.deepEqual(selectOwnedConnectedAgentPubkeys(users, ME), [
      AGENT_OWNED,
    ]);
  });

  it("drops non-agent directory rows even when the owner matches", () => {
    const users = [
      { pubkey: AGENT_OWNED, ownerPubkey: ME, isAgent: false },
      { pubkey: OTHER, ownerPubkey: null, isAgent: false },
    ];

    assert.deepEqual(selectOwnedConnectedAgentPubkeys(users, ME), []);
  });

  it("matches ownership case-insensitively and normalizes + dedupes output", () => {
    const users = [
      {
        pubkey: AGENT_OWNED.toUpperCase(),
        ownerPubkey: ME.toUpperCase(),
        isAgent: true,
      },
      { pubkey: AGENT_OWNED, ownerPubkey: ME, isAgent: true },
    ];

    assert.deepEqual(
      selectOwnedConnectedAgentPubkeys(users, ME.toUpperCase()),
      [AGENT_OWNED],
    );
  });

  it("is safe on undefined inputs", () => {
    assert.deepEqual(selectOwnedConnectedAgentPubkeys(undefined, ME), []);
    assert.deepEqual(
      selectOwnedConnectedAgentPubkeys(
        [{ pubkey: AGENT_OWNED, ownerPubkey: ME, isAgent: true }],
        undefined,
      ),
      [],
    );
    assert.deepEqual(
      selectOwnedConnectedAgentPubkeys(
        [{ pubkey: AGENT_OWNED, ownerPubkey: ME, isAgent: true }],
        null,
      ),
      [],
    );
    assert.deepEqual(
      selectOwnedConnectedAgentPubkeys(
        [undefined, { pubkey: AGENT_OWNED, ownerPubkey: null, isAgent: true }],
        ME,
      ),
      [],
    );
  });
});
