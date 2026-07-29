import assert from "node:assert/strict";
import test from "node:test";

import {
  coalesceAgentAutocompleteCandidates,
  collectVerifiedAgentPubkeys,
  getMentionableAgentPubkeys,
  getSharedChannelIds,
  isAgentIdentityInManagedList,
  relayAgentIsSharedWithUser,
  shouldHideAgentFromMentions,
} from "./agentAutocompleteEligibility.ts";

const CURRENT_PUBKEY = "a".repeat(64);
const OWNER_PUBKEY = "b".repeat(64);
const OTHER_OWNER_PUBKEY = "c".repeat(64);
const PUB_A = "1".repeat(64);
const PUB_B = "2".repeat(64);
const PUB_C = "3".repeat(64);
const PUB_D = "4".repeat(64);

function coalesce(candidates, options = {}) {
  return coalesceAgentAutocompleteCandidates(candidates, {
    currentPubkey: CURRENT_PUBKEY,
    getLabel: (candidate) => candidate.displayName,
    ...options,
  });
}

function makeAgent(overrides = {}) {
  return {
    pubkey: PUB_A,
    displayName: "Pinky",
    isAgent: true,
    isMember: false,
    ...overrides,
  };
}

test("getSharedChannelIds: includes only active joined channels", () => {
  assert.deepEqual(
    getSharedChannelIds([
      { id: "joined", isMember: true, archivedAt: null },
      { id: "not-joined", isMember: false, archivedAt: null },
      { id: "archived", isMember: true, archivedAt: "2026-01-01T00:00:00Z" },
    ]),
    new Set(["joined"]),
  );
});

test("relayAgentIsSharedWithUser: accepts shared anyone agents and rejects unshared ones", () => {
  const sharedChannelIds = new Set(["general"]);

  assert.equal(
    relayAgentIsSharedWithUser(
      { respondTo: "anyone", respondToAllowlist: [], channelIds: ["general"] },
      sharedChannelIds,
    ),
    true,
  );
  assert.equal(
    relayAgentIsSharedWithUser(
      {
        respondTo: "owner-only",
        respondToAllowlist: [],
        channelIds: ["general"],
      },
      sharedChannelIds,
    ),
    false,
  );
  assert.equal(
    relayAgentIsSharedWithUser(
      { respondTo: "anyone", respondToAllowlist: [], channelIds: ["other"] },
      sharedChannelIds,
    ),
    false,
  );
});

test("relayAgentIsSharedWithUser: accepts allowlist agents for the current user", () => {
  const sharedChannelIds = new Set(["general"]);

  assert.equal(
    relayAgentIsSharedWithUser(
      {
        respondTo: "allowlist",
        respondToAllowlist: [OTHER_OWNER_PUBKEY, CURRENT_PUBKEY.toUpperCase()],
        channelIds: ["other"],
      },
      sharedChannelIds,
      CURRENT_PUBKEY,
    ),
    true,
  );
  assert.equal(
    relayAgentIsSharedWithUser(
      {
        respondTo: "allowlist",
        respondToAllowlist: [OTHER_OWNER_PUBKEY],
        channelIds: ["general"],
      },
      sharedChannelIds,
      CURRENT_PUBKEY,
    ),
    false,
  );
});

test("getMentionableAgentPubkeys: keeps managed agents and shared relay agents", () => {
  const result = getMentionableAgentPubkeys({
    managedAgentPubkeys: [PUB_A],
    currentPubkey: CURRENT_PUBKEY,
    relayAgents: [
      {
        pubkey: PUB_B,
        respondTo: "anyone",
        respondToAllowlist: [],
        channelIds: ["general"],
      },
      {
        pubkey: PUB_C,
        respondTo: "allowlist",
        respondToAllowlist: [CURRENT_PUBKEY],
        channelIds: ["other"],
      },
      {
        pubkey: PUB_D,
        respondTo: "anyone",
        respondToAllowlist: [],
        channelIds: ["other"],
      },
    ],
    sharedChannelIds: new Set(["general"]),
  });

  assert.deepEqual(result, new Set([PUB_A, PUB_B, PUB_C]));
});

test("isAgentIdentityInManagedList: keeps people and only current managed agent identities", () => {
  const managedAgentPubkeys = new Set([PUB_A]);

  assert.equal(
    isAgentIdentityInManagedList(
      { isAgent: false, pubkey: PUB_B },
      managedAgentPubkeys,
    ),
    true,
  );
  assert.equal(
    isAgentIdentityInManagedList(
      { isAgent: true, pubkey: PUB_A.toUpperCase() },
      managedAgentPubkeys,
    ),
    true,
  );
  assert.equal(
    isAgentIdentityInManagedList(
      { isAgent: true, pubkey: PUB_B },
      managedAgentPubkeys,
    ),
    false,
  );
});

function directoryEntry(respondTo, respondToAllowlist = []) {
  return { respondTo, respondToAllowlist };
}

test("shouldHideAgentFromMentions: never hides non-agents", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: false,
      isMember: false,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([[PUB_A, directoryEntry("anyone")]]),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: shows invocable agents even when non-member", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: false,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set([PUB_A]),
      directoryAgentsByPubkey: new Map([[PUB_A, directoryEntry("anyone")]]),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: hides non-member non-invocable agents", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: false,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map(),
    }),
    true,
  );
});

test("shouldHideAgentFromMentions: hides member agents whose allowlist excludes the current user", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([
        [PUB_A, directoryEntry("allowlist", [OTHER_OWNER_PUBKEY])],
      ]),
    }),
    true,
  );
});

test("shouldHideAgentFromMentions: shows member agents whose allowlist includes the current user", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([
        [PUB_A, directoryEntry("allowlist", [CURRENT_PUBKEY.toUpperCase()])],
      ]),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: shows member agents with unknown invocability (not in directory)", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map(),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: shows member agents with a vacuous directory entry (respondTo null)", () => {
  // `buzz channels set-add-policy` publishes kind:10100 without
  // respond_to/channel_ids — directory presence alone must not hide a member.
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([[PUB_A, directoryEntry(null)]]),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: shows anyone-mode member agents even with stale channel ids", () => {
  // "anyone" + empty channel_ids keeps the agent out of the invocable set,
  // but a co-member of the current channel responds to us regardless.
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([[PUB_A, directoryEntry("anyone")]]),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: shows owner-only member agents (harness decides)", () => {
  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: PUB_A,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([[PUB_A, directoryEntry("owner-only")]]),
    }),
    false,
  );
});

test("shouldHideAgentFromMentions: normalizes the pubkey before lookup", () => {
  const mixedCase = "Ab".repeat(32);
  const normalized = mixedCase.toLowerCase();

  assert.equal(
    shouldHideAgentFromMentions({
      isAgent: true,
      isMember: true,
      pubkey: mixedCase,
      currentPubkey: CURRENT_PUBKEY,
      mentionableAgentPubkeys: new Set(),
      directoryAgentsByPubkey: new Map([
        [normalized, directoryEntry("allowlist", [OTHER_OWNER_PUBKEY])],
      ]),
    }),
    true,
  );
});

test("coalesceAgentAutocompleteCandidates: merges agents with the same persona id", () => {
  const first = makeAgent({ pubkey: PUB_A, personaId: "pinky" });
  const second = makeAgent({
    pubkey: PUB_B,
    personaId: "pinky",
    isMember: true,
  });

  assert.deepEqual(coalesce([first, second]), [second]);
});

test("coalesceAgentAutocompleteCandidates: merges agents with the same owner and name", () => {
  const first = makeAgent({ pubkey: PUB_A, ownerPubkey: OWNER_PUBKEY });
  const second = makeAgent({
    pubkey: PUB_B,
    ownerPubkey: OWNER_PUBKEY,
    isMember: true,
  });

  assert.deepEqual(coalesce([first, second]), [second]);
});

test("coalesceAgentAutocompleteCandidates: keeps same-name agents with different owners distinct", () => {
  const first = makeAgent({ pubkey: PUB_A, ownerPubkey: OWNER_PUBKEY });
  const second = makeAgent({
    pubkey: PUB_B,
    ownerPubkey: OTHER_OWNER_PUBKEY,
  });

  assert.deepEqual(coalesce([first, second]), [first, second]);
});

test("coalesceAgentAutocompleteCandidates: keeps owner-less same-name agents distinct", () => {
  const first = makeAgent({ pubkey: PUB_A });
  const second = makeAgent({ pubkey: PUB_B });

  assert.deepEqual(coalesce([first, second]), [first, second]);
});

test("coalesceAgentAutocompleteCandidates: keeps owner-less managed same-name agents distinct", () => {
  const first = makeAgent({ pubkey: PUB_A, isManagedAgent: true });
  const second = makeAgent({ pubkey: PUB_B, isManagedAgent: true });

  assert.deepEqual(coalesce([first, second]), [first, second]);
});

test("coalesceAgentAutocompleteCandidates: merges current-owner same-name agents", () => {
  const first = makeAgent({ pubkey: PUB_A, ownerPubkey: CURRENT_PUBKEY });
  const second = makeAgent({
    pubkey: PUB_B,
    ownerPubkey: CURRENT_PUBKEY,
    isManagedAgent: true,
  });

  assert.deepEqual(coalesce([first, second]), [second]);
});

test("coalesceAgentAutocompleteCandidates: leaves non-agents alone", () => {
  const first = makeAgent({ pubkey: PUB_A, isAgent: false });
  const second = makeAgent({ pubkey: PUB_B, isAgent: false });

  assert.deepEqual(coalesce([first, second]), [first, second]);
});

test("getMentionableAgentPubkeys: unions verifiedAgentPubkeys when provided", () => {
  const result = getMentionableAgentPubkeys({
    currentPubkey: CURRENT_PUBKEY,
    managedAgentPubkeys: [PUB_A],
    relayAgents: [],
    sharedChannelIds: new Set(),
    verifiedAgentPubkeys: [PUB_B.toUpperCase(), PUB_C],
  });

  assert.equal(result.has(PUB_A), true);
  assert.equal(result.has(PUB_B), true, "verified pubkeys are normalized");
  assert.equal(result.has(PUB_C), true);
});

test("getMentionableAgentPubkeys: omitting verifiedAgentPubkeys preserves prior behavior", () => {
  const result = getMentionableAgentPubkeys({
    currentPubkey: CURRENT_PUBKEY,
    managedAgentPubkeys: [PUB_A],
    relayAgents: [],
    sharedChannelIds: new Set(),
  });

  assert.deepEqual([...result], [PUB_A]);
});

test("collectVerifiedAgentPubkeys: keeps only verified isAgent entries, normalized", () => {
  const result = collectVerifiedAgentPubkeys([
    { pubkey: PUB_A.toUpperCase(), isAgent: true },
    { pubkey: PUB_B, isAgent: false },
    { pubkey: PUB_C },
    { pubkey: PUB_D, isAgent: null },
  ]);

  assert.deepEqual([...result], [PUB_A]);
  assert.deepEqual([...collectVerifiedAgentPubkeys(undefined)], []);
});
