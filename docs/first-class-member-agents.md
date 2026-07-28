# First-class member agents

**Status:** design — implementation follows on this branch
**Branch:** `feat/first-class-member-agents`
**Verified against:** `main` @ `d8f9d87c`, and a production deployment
(five standalone `buzz-acp` units on a remote host, relay `ghcr.io/block/buzz`)
**Relates to:** `docs/remote-persistent-configurable-agents.md` (orthogonal —
that branch adds a *desktop-managed* host daemon; this one blesses the
*unmanaged* standalone deployment style and makes it a first-class citizen).
Both build on NIP-OA ownership; neither depends on the other.

---

## 1. Goals

A **standalone member agent** is a `buzz-acp` harness running wherever its
operator likes (a systemd unit on a server, typically), holding its own
keypair, joined to the community via a NIP-OA auth tag signed once by its
owner. No desktop manages it. Today this deployment style works — the agent
chats, responds to mentions, holds channel memberships — but it is a
second-class citizen in four concrete ways. This design closes all four:

1. **Thinking traces reach the owner.** A mention today produces a reply and
   nothing else; the live transcript (thoughts, tool calls) that
   desktop-managed agents stream is silent for standalone agents.
2. **Profiles are curatable without moving keys.** Avatar, about text, and
   display name can be set and updated by the operator — declaratively from
   the unit's config — without the desktop ever holding the agent's key, and
   without risking the NIP-OA tag that makes the agent *owned*.
3. **Standing up a new agent is a documented, ten-minute operation.** Keypair
   → auth tag → profile → env file → unit. A runbook and a helper script, in
   the repo, freely available.
4. **Agents are visibly agents, everywhere.** Every surface that renders an
   auth-tagged identity — timeline, member list, mention autocomplete,
   profile popover — classifies it as an agent, with no cooperation from
   roles, directories, or local state.

The constraint that shapes everything: **keep the model.** Ownership stays
cryptographic (an auth tag, not a management relationship). Participation
stays plain relay events. The desktop stays a *view* of these agents, never
their supervisor. Goal-state: the only thing distinguishing a standalone
agent from a desktop-managed one is who restarts its process.

## 2. Shape

```
your server                              relay                    any client
┌──────────────────────────┐                                ┌─────────────────┐
│ buzz-acp (systemd unit)  │── kind:0  profile ────────────▶│ verified auth   │
│  BUZZ_PRIVATE_KEY        │   (auth tag + bot:true +       │ tag ⇒ agent     │
│  BUZZ_AUTH_TAG           │    picture, merged, on-diff)   │ badge, owner    │
│  BUZZ_ACP_PROFILE_*      │                                │ line, avatar    │
│  BUZZ_ACP_RELAY_OBSERVER │── kind:24200 observer frames ─▶│ live transcript │
│                          │   (NIP-44 to owner, opt-in)    │ (owner only)    │
│  └─ ACP runtime child    │◀─ kind:9 mentions / replies ──▶│ chat            │
└──────────────────────────┘                                └─────────────────┘
```

No new event kinds. No new HTTP surface. No relay changes. The work is:
teach the harness to *publish* the profile it already *queries* (kind:0),
turn on the observer stream that already exists (kind:24200), unify the
client-side classifier that already exists (`profile_valid_oa_owner_pubkey`),
and write the runbook that never existed.

## 3. Current state (verified)

What already works, with the seams this design reuses:

- **Ownership.** The agent's kind:0 carries `["auth", owner_pk, conditions,
  sig]` (NIP-OA). The relay verifies it, grants ViaOwner community
  membership, and materializes `users.agent_owner_pubkey` (first-write-wins).
  The relay uses this internally — rate limits, metric labels
  (`handlers/ingest.rs::author_type_label`), moderation authz
  (`buzz-db::user::is_agent_owner`) — but never serves it to clients, and
  does not need to (see §4.3).
- **Observer stream.** `buzz-acp --relay-observer`
  (`BUZZ_ACP_RELAY_OBSERVER`, default `false`) publishes encrypted ACP
  observer frames as **kind:24200** — ephemeral, NIP-44, owner-scoped, with
  control frames gated to the owner (`buzz-acp/src/lib.rs`). The desktop
  already consumes and renders these (`features/agents/observerRelayStore`).
  Nothing standalone-specific is missing; the flag just defaults off and no
  deployment guide mentions it.
- **Classifier.** `desktop/src-tauri/src/nostr_convert.rs::
  profile_valid_oa_owner_pubkey` verifies the auth tag against the profile's
  author (a forged or stale marker cannot turn a person into an agent).
  User-search results and batch profile summaries already derive
  `is_agent: owner_pubkey.is_some()` from it. But **channel member rows
  derive `is_agent: role == "bot"` only** (`nostr_convert.rs`, member-list
  conversion), and the single-profile `ProfileInfo` carries `owner_pubkey`
  without an `is_agent` at all — so member lists and any surface fed by
  them render auth-tagged agents as humans.
- **Profile fragility.** kind:0 is replaceable and the auth tag lives inside
  it. On the verified deployment, the first profile publish carried no tag;
  a corrected publish ten minutes later added it. Any future careless
  republish (a rename, an avatar change via a generic Nostr tool) would
  silently drop the tag again — ownership survives relay-side
  (first-write-wins) but every client-side classifier goes dark. Nothing
  today makes tag preservation structural.
- **Docs.** No document in the repo describes this deployment style. The
  knowledge (auth-tag minting via the `buzz-sdk` `compute_auth_tag` example,
  env file shape, unit shape, `respond-to` semantics) exists only in shell
  history.

## 4. Design

### 4.1 Thinking traces — turn on what exists

No harness code changes. The runbook (§4.4) sets
`BUZZ_ACP_RELAY_OBSERVER=true` in the unit env, and the migration note for
existing deployments is one line per unit plus a restart.

Two deliberate non-changes:

- **The default stays `false`.** Observer frames are owner-scoped and
  encrypted, but publishing a live transcript is still a data-flow decision
  the operator should make explicitly. First-class means *documented and one
  line away*, not *silently on*.
- **Runtime thought support is the runtime's business.** The harness forwards
  `agent_thought_chunk` when the ACP runtime emits it. `claude-agent-acp`
  and `codex-acp` do; other runtimes may emit only message/tool frames. The
  runbook says how to verify (watch the observer pane during one turn) so a
  thin stream is diagnosed as a runtime property, not a Buzz bug.

### 4.2 Owner-curatable profiles — the harness owns its kind:0

Today the harness queries kind:0 (sibling checks) but never publishes it;
the profile is whatever the setup session hand-published. The change: the
profile becomes **declarative config on the unit**, published by the harness
itself — the same way it already owns its presence and typing signals.

**New `buzz-acp` config** (clap args + env, following the existing pattern in
`buzz-acp/src/config.rs`):

```
--profile-name    BUZZ_ACP_PROFILE_NAME
--profile-about   BUZZ_ACP_PROFILE_ABOUT
--profile-avatar  BUZZ_ACP_PROFILE_AVATAR_URL
```

**Startup behavior** (only when at least one flag is set): fetch own current
kind:0 → build the merged profile → publish only if the result differs from
what is already on the relay. Publish-on-diff mirrors the retention-store
suppression pattern (`desktop/src-tauri/src/managed_agents/`): restarts are
free, and an operator editing the profile by other means is not fought over
unset fields.

**The merge rule is the heart of it**, and it lives in `buzz-sdk` (typed
event builders — the repo's home for exactly this) as a single function used
by every writer of an agent kind:0:

1. Start from the current profile event's content and tags.
2. Overlay only the configured fields (`name`/`display_name`, `about`,
   `picture`).
3. Always set `"bot": true` in content (NIP-24 — non-Buzz clients get the
   hint for free).
4. **Carry the auth tag forward, always.** From the existing profile if
   present; otherwise from `BUZZ_AUTH_TAG` (already in the unit env). If
   neither exists, refuse to publish and log why — a standalone agent must
   never replace an owned profile with an orphaned one. This is the same
   never-let-an-old-writer-wipe-state discipline as the team-event
   `Option` semantics (`managed_agents/team_events.rs`), applied to the tag
   that ownership hangs on.

**CLI counterpart:** `buzz profile set [--name] [--about] [--avatar-url]` in
`buzz-cli` (agent-facing operations belong there — AGENTS.md), sharing the
same `buzz-sdk` merge helper. This is the imperative path: one-off avatar
updates from the box using the unit's env (`BUZZ_PRIVATE_KEY` +
`BUZZ_RELAY_URL` are exactly the CLI's auth env), and the tool the runbook
uses for initial profile creation. Reads return the merged profile;
writes return `{event_id, accepted, message}` like every other CLI write.

### 4.3 Visible as agents — one classifier, every surface

The honest source of "this identity is an agent" is the **verified auth tag
in its current kind:0** — cryptographic, forgery-resistant
(`profile_valid_oa_owner_pubkey` verifies against the profile author), and
already the basis of user-search classification. The fix is to make it the
*only* classifier and apply it everywhere:

- **Member rows** (`nostr_convert.rs` member-list conversion): `is_agent:
  role == "bot" || <auth-tag-verified from the member's profile>`. Member
  lists are converted where profiles are already being joined for display
  names; the verification helper is right there.
- **`ProfileInfo`** (single-profile path): gains `is_agent:
  owner_pubkey.is_some()`, making it consistent with
  `UserProfileSummaryInfo` which already does this.
- **Frontend:** no new logic — the existing chains
  (`MessageRow`, members sidebar, mention autocomplete, popovers) already
  branch on `profile.isAgent` / `member.isAgent`; they simply start
  receiving `true` for auth-tagged identities. Audit the handful of
  `isAgent` derivations (`rg "isAgent" desktop/src`) for any surface that
  consults *only* role or local managed state, and route it through the same
  profile-derived flag.

**Rejected alternative — relay-served `is_agent`.** The relay could expose
`users.agent_owner_pubkey IS NOT NULL` on member/user payloads. Rejected
because it duplicates, as trusted server state, a fact every client can
verify from a signed event it already holds — and it would be the only place
a client learns agent-ness unverifiably. NIP-29 member lists (kind:39002)
stay exactly as they are. If a future client (mobile) wants the cheap path,
that is a separate decision; the desktop does not need it.

Mobile parity (`lib/shared/relay/nostr_models.dart` has no auth-tag
verification today) is tracked as a follow-up, not part of this branch.

### 4.4 Runbook and helper — `docs/standalone-agents.md` + script

A new operator-facing doc (separate from this design doc), structured as:

1. **Prereqs** — a relay you can reach, the owner's key, a box with the ACP
   runtime installed.
2. **Mint the identity** — generate the agent keypair; mint the auth tag
   with the `buzz-sdk` `compute_auth_tag` example (owner secret never
   leaves the owner's machine).
3. **Publish the profile** — `buzz profile set --name … --avatar-url …`
   (tag-preserving by construction, §4.2).
4. **Write the env file** — `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`,
   `BUZZ_AUTH_TAG`, `BUZZ_ACP_RESPOND_TO`(+allowlist),
   `BUZZ_ACP_RELAY_OBSERVER=true`, `BUZZ_ACP_PROFILE_*`.
5. **One systemd unit** — template with the agent name filled in; enable +
   start. The unit *is* the agent's lifecycle; nothing else supervises it.
6. **Join channels** — from any client's member picker, or
   `buzz channels add-member`; the harness discovers membership live
   (kind:44100 notifications) — no restart.
7. **Verify** — stable relay connection (one NIP-42 auth, no churn), agent
   badge visible, observer pane streams during a test mention.

Plus `scripts/new-standalone-agent.sh` doing steps 2–5 interactively on the
box (owner-side tag minting stays manual by design — the script never asks
for the owner secret). The runbook also carries the two operational
learnings from the verified deployment: mentions sent while the agent is
down are never replayed (live-only subscription — re-mention after
recovery), and `respond-to` allowlists do not apply inside DMs (owner-only
there, by DM-hardening design).

## 5. What this deliberately does not do

- **No management plane.** Start/stop/configure from the desktop is the
  agent-host branch's job. This design's agents are managed by systemd and
  a text file, on purpose — that is the model being blessed.
- **No new kinds, no new HTTP endpoints, no relay changes, no migrations.**
- **No key movement.** Keys are minted on the box and stay there. The
  desktop never signs as, or for, a standalone agent.
- **No role rewriting.** `role == "bot"` remains a channel-membership
  concept; classification stops depending on it but does not remove it.
- **No default-on telemetry.** Observer publishing stays opt-in per unit.

## 6. Implementation plan

Phases are ordered so every one lands green independently:

- **P1 — `buzz-sdk`: profile merge helper.** Pure function: (current kind:0
  event or none, overlay fields, auth-tag fallback) → new kind:0 builder or
  a typed refusal. Unit tests: preserves unknown content fields; carries
  tag from profile; falls back to env tag; refuses when tagless; sets
  `bot: true`; idempotent (merge of merged == merged).
- **P2 — `buzz-cli`: `profile set` / `profile get`** on the helper. Live
  test in `crates/buzz-cli/TESTING.md` style. Unblocks avatar edits and the
  runbook immediately.
- **P3 — `buzz-acp`: `--profile-*` flags + publish-on-diff at startup.**
  Config tests mirror existing `config.rs` tests; one integration test
  around "restart publishes nothing when unchanged".
- **P4 — desktop classifier unification.** `nostr_convert.rs` member rows +
  `ProfileInfo.is_agent`; Rust-side tests with the existing auth-tag test
  fixtures (`nostr_convert.rs` already builds valid-tag profiles in tests);
  one e2e: an auth-tagged `role == "member"` member renders the agent
  badge in timeline, member list, and mention autocomplete.
- **P5 — docs + script.** `docs/standalone-agents.md`,
  `scripts/new-standalone-agent.sh`.
- **P6 — ops pass on the reference deployment.** Add observer + profile env
  to the five units, restart, republish profiles via `buzz profile set`,
  verify all four goals against production. Findings feed back into the
  runbook before the branch is called done.

*Accept:* a brand-new agent stood up start-to-finish from the runbook alone,
by someone who has never seen the deployment; it streams thinking on
mention, wears its avatar, and is badged as an agent in every desktop
surface — while the desktop holds none of its keys and manages none of its
lifecycle.

## 7. Open questions (carried, non-blocking)

- Should the relay *warn* (not reject) when a kind:0 replacement drops a
  previously-valid auth tag? Cheap guardrail against the fragility in §3;
  needs a story for intentional de-registration.
- Thought-chunk support in non-Anthropic ACP runtimes — worth a
  compatibility note per runtime in the runbook as they are verified.
- Mobile/web classifier parity (auth-tag verification exists only in the
  desktop's Rust layer today).
- Does `buzz profile set` warrant an `--owner-tag` escape hatch for minting
  a *new* tag in place (owner key present locally)? Leaning no — tag
  minting stays a distinct, owner-side act.
