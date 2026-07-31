# Swarms — delegation groups with a leader

**Status:** design, implementation-ready
**Depends on:** the connected-agent parity stack (verified-agent enumeration,
owner-published kind:30177 definitions, the buzz-acp definition fetch)
**Relates to:** Teams (kind:30176) — deliberately untouched; see §1.

A **swarm** is a named group of agents with a required **leader**. Mentioning
the leader activates delegation: the leader's job is to attribute the task to
exactly one swarm member — never to complete it — and, when reporting is on,
to evaluate the member's result against owner-defined criteria.

---

## 1. Why parallel to Teams, not inside Teams

Teams is upstream-owned *provisioning* machinery (persona packs, `sourceDir`
/ `plugin.json`, repair-by-manifest-ID, deploy-creates-managed-agents).
Swarms is a *routing* concept keyed on pubkeys, which treats managed and
connected agents uniformly. Extending Teams would mean surgery in upstream
hot files and semantic entanglement; Swarms lands as new files + one new
event kind — the fork's lowest-merge-cost shape and a self-contained
upstream PR later. Teams stays exactly as it is.

## 2. Simplicity keystones (the load-bearing decisions)

1. **The swarm is addressed by mention aliasing — no new identity.**
   "@devswarm" is a first-class mention-autocomplete candidate; selecting it
   emits the *leader's* p-tag plus a `["swarm", "<swarm-id>"]` tag on the
   message (and "@devswarm" as the visible text). The leader's harness
   enters leader mode only when its own mention arrives WITH a swarm tag
   naming a definition it leads; a plain "@Leader" mention stays ordinary
   agent behavior. This kills three birds: swarms initiate from channels,
   no keypair/custody/presence questions ever arise, and leaders no longer
   need to be swarm-dedicated. (Clients without swarm awareness can still
   address a swarm by mentioning the leader and adding the tag — or just
   talk to the leader directly.)
2. **Members are completely swarm-unaware.** No member-side harness or
   schema changes. Delegation is a normal in-thread mention from the leader
   (fires the member's turn today); report-back is a *sentence in the
   assignment text* ("when finished, reply in this thread mentioning
   @Leader"), not protocol. Verified loop-safety fact this leans on: replies
   carry only an `e` tag — no auto p-tag of the parent author
   (`crates/buzz-sdk/src/builders.rs:734`) — so nothing re-fires without an
   explicit mention.
3. **One new event kind, one relay match-arm.** The swarm definition is an
   owner-signed parameterized-replaceable event, published and fetched
   exactly like the 30177 agent definition. The relay's ingest scope map
   rejects unknown kinds, so 30978 is registered there with the same
   UsersWrite shape as its NIP-AP siblings (see §7 P1.5 for the
   deployment consequence).
4. **v1 constraints:** same-owner members only (the sibling rule admits the
   leader through every member's respond gate automatically); model names in
   the roster are best-effort (see §5 gap); cross-owner swarms are a later
   phase gated on allowlist UX.

## 3. Event schema

`buzz-core/src/kind.rs`: `KIND_SWARM: u32 = 30978` (parameterized
replaceable; registry entry alongside 30175/30176/30177).

Author: the swarm owner. `d` tag: stable swarm id (uuid). Content follows
the Option never-wipe discipline (`team_events.rs` precedent — absent field
⇒ leave stored value untouched):

```json
{
  "name": "Build crew",
  "leader_pubkey": "<hex>",
  "instructions": "<leader/manager instructions — the high-priority block>",
  "members": [
    { "pubkey": "<hex>", "description": "This agent should do bug fixes" }
  ],
  "report_back": true,
  "evaluation_criteria": "<owner-defined success criteria>"
}
```

`buzz-sdk`: `build_swarm_definition` / parse counterpart, mirroring the team
event builders (typed content struct, unknown-field-preserving).

## 4. Leader behavior (buzz-acp)

Mirrors the existing owner-definition fetch (the 30177 path) — same query
seams, same `[System]` assembly:

1. **Fetch:** at session start (and on a freshness window per turn), query
   kind:30978 authored by the resolved NIP-OA owner whose
   `leader_pubkey == self`. No swarm ⇒ zero behavior change.
2. **Trigger predicate:** inject swarm context only when the triggering
   event p-tags the leader directly (the harness already evaluates mention
   p-tags for its filter). Thread follow-ups that don't mention the leader
   change nothing.
3. **`[System]` assembly order** (high → low priority):
   1. Built-in leader template (fixed string in the harness):
      *you lead the swarm "{name}"; your job is to attribute the task to
      exactly ONE member by mentioning them in this thread; never do the
      work yourself; if a member already answered in-thread, evaluate or
      reassign rather than redo; when `report_back` is set, end every
      assignment with an instruction to reply in this thread mentioning
      @you on completion; when a member reports back, evaluate the result
      against the evaluation criteria and either confirm completion to the
      requester or reassign with feedback.*
   2. The swarm `instructions` field (the owner's high-priority block).
   3. Member roster — one line per member: display name (kind:0), the
      swarm-definition `description`, bio/about (kind:0), model
      (best-effort, §5).
   4. The leader's own 30177 definition (unchanged, lowest of the four).
4. **Reporting off:** template omits the report-back sentence;
   `evaluation_criteria` is still stored but not injected.

No queue, dispatch, or member-side changes anywhere.

## 5. Known gap: model discoverability

Nothing today carries a model name for connected agents (kind:0, the 10100
directory — `agentType`/`capabilities` only — and 30177 all lack it). v1
roster lines omit the model when unknown; managed agents can fill it from
local runtime config when the leader is desktop-adjacent — otherwise
"model: unknown" is acceptable. Durable fix (separate, small): add an
optional `model` field to the 30177 definition content, owner-authored.

## 6. Desktop UI

Placement: the Agents page, a **Swarms section directly below Teams**
(`AgentsView` — one import + one JSX insertion, same collapsible
section-heading idiom as Connected agents). Cards reuse the section/card
idioms; each swarm card shows name, leader avatar, member count, Edit.
Plus-card at the end of the grid opens the create dialog.

### Create/edit dialog (spec)

- **Header:** "Create Swarm" / "Edit Swarm" — subtext: *"Group agents
  together for quick deployment and delegation"*.
- **Name** field (single line; needed for the section listing — defaults in
  the placeholder to "{Leader}'s swarm" and may be left empty to use that).
- **Section "Leader"**
  - Field **Leader** — subtext: *"The leader delegates tasks to members of
    the swarm"* — dropdown of available agents (managed + verified
    connected; the shared enumeration from the parity work).
  - Field **Instructions** — multiline; becomes the `instructions` block.
- **Section "Members"** — subtext: *"Select agents to include in this
  swarm."*
  - Repeating row/card:
    - **F1:** agent dropdown (the current leader excluded; already-picked
      members excluded).
    - **F2:** Description textbox — placeholder: *"This agent should write
      specifications/generate images/execute small code changes/do bug
      fixes"*.
  - **+** icon appends an empty row.
- **Section "Reporting"**
  - Toggle: **"Report back to leader on completion"** (`report_back`).
  - Textfield — subtext: *"Define evaluation and success criteria for the
    manager"* (`evaluation_criteria`; disabled while the toggle is off,
    value retained).
- Save publishes the kind:30978 event owner-signed (the
  `setConnectedAgentInstructions` publish pattern); the leader picks it up
  at its next session — works while the leader is offline.
- Row-level warning when a selected member's directory entry says it will
  not respond to the leader (the Option B allowlist signal); same-owner
  members never warn.

### New files (no hot-file edits beyond the one AgentsView insertion)

- `desktop/src/features/agents/ui/SwarmsSection.tsx`
- `desktop/src/features/agents/ui/SwarmDialog.tsx`
- `desktop/src/features/agents/lib/swarmDefinition.ts` (query + publish +
  pure content mapping, mirroring `connectedAgentDefinition.ts`; unit tests
  in a sibling `.test.mjs`)
- Kind constant in `desktop/src/shared/constants/kinds.ts` (+ keep
  `mobile/lib/shared/relay/nostr_models.dart` in sync per repo rule).

## 7. Implementation plan

- **P1 — schema:** `buzz-core` kind + registry; `buzz-sdk` builders/parse
  with Option discipline. Unit tests: round-trip, unknown-field
  preservation, absent-field never-wipe. **Done** (`feat/swarms`).
- **P1.5 — relay acceptance (discovered while landing):** the ingest scope
  map REJECTS unknown kinds (`handlers/ingest.rs::required_scope_for_kind`),
  so 30978 needed explicit acceptance (UsersWrite + h-tag immunity, same as
  persona/team/managed-agent). **Done** (`f1b3fe24`). **Deployment
  consequence:** the production relay runs the pinned upstream image —
  swarm publishes bounce with "unknown kind" until the relay runs a build
  containing this arm. Options: build + pin a fork relay image on the prod
  host, or upstream this one-liner and wait for the next official image.
  Owner's call; nothing else in the feature is blocked by it (everything
  ships dormant).
- **P2 — harness:** fetch + trigger predicate + assembly in `buzz-acp`
  (mirrors the 30177 fetch seams). Tests: no-swarm no-op; injection only on
  direct mention; assembly order; report-back sentence toggled by
  `report_back`. **Done** (`feat/swarms`; 1,158 crate tests green).
- **P3 — desktop:** section + dialog + publish path + tests as above.
  **Done** (`feat/swarms-desktop`, five commits + size-guard extractions;
  3,898 desktop tests green; Tauri Rust compile-checked). Notes: the
  frontend→event tag channel is prefix-validated (`swarm_tags` param
  mirroring `mention_tags`'s anti-forgery rule — verbatim append was
  deliberately rejected); swarm mention rows use the `Network` icon and
  appear only in channel composers whose leader can hear the channel;
  `useVerifiedAgents` now dedupes the six enumeration copies. Accepted
  one-time ratchet overage: `commands/messages.rs` +3 (the parameter).
- **P4 — verify on the reference deployment:** define a swarm over two
  gradient agents, mention the leader in a channel, watch: leader assigns
  one member in-thread, member answers, (reporting on) member mentions
  leader, leader evaluates against criteria. Journal at debug shows the
  sibling admissions; observer panes show both turns.

*Accept:* mentioning the leader produces an assignment mention to exactly
one member and no self-answer; with reporting on, the loop closes with the
leader's evaluation; deleting the swarm event restores plain-agent behavior
with no restarts anywhere.

### P4 status (2026-07-30) and operator handoff

Everything local is shipped: schema, relay acceptance, harness, desktop UI
+ mention aliasing, all gates green, app installed. The live loop needs
three operator steps that are blocked on access/keys, in order:

1. **Gradient SSH re-auth** — the Cloudflare Access session expired
   mid-rollout (`ssh gradient-ssh` now stalls in the browser SSO dance).
   Open any `ssh gradient-ssh` from a terminal and complete the SSO prompt.
2. **Relay must accept kind:30978** — prod runs the pinned upstream image,
   which rejects the kind. Either build + pin a fork image
   (`cd ~/buzz && git pull && DOCKER_BUILDKIT=1 docker build …` then set
   `BUZZ_IMAGE` in `deploy/compose/.env` and `./run.sh restart`;
   ~30 s agent 502 window) or upstream `f1b3fe24` first and wait for the
   next official image. Until then, Save in the Swarm dialog will surface
   the relay's rejection — the UI ships dormant, nothing breaks.
3. **Harness rollout** — the five units need the feat/swarms buzz-acp:
   `cd ~/buzz && git checkout deploy && git pull && cargo build --release
   -p buzz-acp && sudo install -m755 target/release/buzz-acp
   /usr/local/bin/buzz-acp && sudo systemctl restart buzz-acp-{claude,codex,hermes,hermesgpt,threemes}`
   (backup first per the 07-29 pattern; verify the binary mtime is seconds
   old — `just ci` does NOT produce release binaries).

Then the one-click verification (owner-signed, so it must be you):
relaunch Buzz → Agents → Swarms → Create Swarm (leader: Moooclaude;
members: codex + one hermes with descriptions; Reporting on with a
criteria line) → open a channel the leader is in → type `@` and pick the
swarm → send a small task. Expect: leader replies in-thread assigning
exactly ONE member with the report-back instruction; the member answers;
the member's report fires the leader; the leader evaluates against your
criteria. `journalctl -u buzz-acp-claude | grep swarm` shows
`swarm-addressed turn — entering leader mode`.

## 8. Report-back enforcement — assignment watches

**Status: IMPLEMENTED and deployed 2026-07-30** (`feat/swarm-assignment-watches`,
merged at `52ea7cb6`; 659 harness tests green, clippy clean; all five
units rolled). One deviation from the sketch below: watch subscriptions
are also dropped on relay reconnect (not only restart) — they expire
harmlessly; re-arm by re-assigning.

**Problem (observed live, 2026-07-30):** report-back rode the assignment
text, so it was only as reliable as the member's model remembering to
@-mention the leader. A member completed its task without the mention and
the loop died silently. Worse: in Mentions mode the leader's subscription
never even RECEIVES an un-mentioning reply (the mention filter drops it
relay-side) — no prompt wording can fix that.

**Principle: the supervisor watches; the worker stays dumb.** All
enforcement lands in the leader's harness — the one place swarm logic
already lives. Members remain 100% swarm-unaware (keystone #2 survives),
which keeps this working for any member harness version and, later,
cross-owner members or even human workers.

### Mechanism (buzz-acp only, new module `swarm_watch.rs`)

1. **Arm.** The event loop already receives the leader's own outgoing
   messages (they arrive and are then dropped as self-authored —
   `lib.rs:2219`; the hook goes just before that drop). When a
   self-authored message satisfies ALL of:
   - its thread ROOT carries a `["swarm", <id>]` tag for a swarm this
     agent leads (the root is the client-built @swarm message, so the tag
     is mechanical, never model-typed; root resolution reuses
     `parse_thread_tags` + the existing thread-root walker),
   - that swarm has `report_back: true`,
   - it p-tags at least one member of that swarm,
   → register `AssignmentWatch { thread_root, channel, swarm_id,
   members_assigned, armed_at }`. In-memory only; watches do not survive a
   restart (same live-only stance as mention replay, documented). Cap 16
   concurrent, oldest evicted with a warn.
2. **Watch.** Each armed watch opens one live relay subscription:
   `kinds:[9], #e:[thread_root], since:now`. This is the piece that makes
   enforcement possible at all — it bypasses the mention filter for
   exactly one thread, for exactly as long as an assignment is open.
3. **Fire.** A watched event whose author is one of `members_assigned`
   (never self) is pushed into the ordinary turn queue for that channel.
   The queue's existing event-id dedup absorbs the double-delivery case
   where a well-behaved member DID mention the leader (arrives via both
   paths). The author gate admits same-owner members as siblings — v1's
   same-owner constraint keeps this closed; the cross-owner phase must
   teach the gate to admit watched-thread authors.
4. **Evaluate.** The prompt path injects the `[Swarm Leader]` section for
   watch-fired turns too (today's predicate is trigger-tag-based; it gains
   the watch marker), with a REPORT-RECEIVED framing: *"a member you
   assigned replied in the supervised thread — evaluate against the
   evaluation criteria; confirm completion to the requester or reassign
   with concrete feedback."* Firing closes the watch.
5. **Expire.** Watches time out (30 minutes, constant in v1). v1 logs and
   drops. An env-gated nudge turn ("no report yet — follow up or
   reassign") is the natural v1.1, default off, so prod never gains
   surprise messages from an upgrade.

### Consequences

- `report_back` becomes structural: ON arms watches; OFF means no watch,
  no supervision — the toggle finally does what it says.
- The leader template DROPS the "instruct the member to @-mention you"
  sentence (unreliable, now unnecessary) and instead says replies in the
  thread are picked up automatically.
- Loop safety is preserved by shape: only the leader auto-fires, only on
  assigned members' replies, only inside supervised threads, only while a
  watch is open. Members never auto-fire; the leader's own confirmation
  replies fire no one.
- Casual leader mentions of members outside swarm threads arm nothing
  (the thread-root swarm tag is required), so non-dedicated leaders stay
  safe.

### Scope

~250–400 lines in buzz-acp (`swarm_watch.rs` registry + pure predicates,
three integration points: own-message hook, watch-event routing, expiry
sweep on the existing tick) + tests for: arming predicate (root-tag +
member-mention + report_back), non-arming cases (no tag / reporting off /
foreign thread), fire-on-member-reply, self/non-member ignored, dedup
against the mention path, cap eviction, expiry. No relay, desktop, CLI,
SDK, or member-side changes. Ships via the standard harness rollout
(rebuild + restart the five units).

## 8.1 Swarm self-deployment — members join on first address

**Status: IMPLEMENTED and deployed 2026-07-30** (`6ee2a8e2`, deploy-direct
commit; 662 harness tests green; all five units rolled).

A swarm member missing from the channel had no subscription there, so an
assignment mentioning it was silently undeliverable. Now, on every
ASSIGNED swarm turn — before the model runs — the leader's harness diffs
the swarm roster against the channel's kind:39002 membership and publishes
kind:9000 adds (role bot) for the missing members. The relay's
`channel_add_policy` stays the authorizer (the huddle-add precedent), and
the member's replay-from-membership subscribe delivers the subsequent
assignment even when it races the join. Product consequence, by design:
addressing a swarm in a channel deploys its members into that channel's
member list — "quick deployment" literally.

Guardrails: declined adds mark the member "NOT REACHABLE in this channel"
in the leader's roster (it says so instead of assigning into the void);
an unavailable membership snapshot publishes nothing (no duplicate-add
spam) and marks nobody; adds cap at 8 per turn. Logs under
`swarm::deploy` ("swarm member deployed to channel" / "add declined").
Report-received turns skip deployment entirely.

## 9. Non-goals (v1)

- No changes to Teams, members' harnesses, the relay, or mobile (beyond the
  kind-constant sync).
- No hard enforcement of "never completes the task" (prompt-level only; a
  harness output gate is a possible later hardening).
- No cross-owner members, no swarm-owned identity/avatar, no nested swarms.

## 9. Open questions (non-blocking)

- ~~Swarm display identity~~ **Resolved (Kevin, 2026-07-29): swarms are
  addressable via mention aliasing (§2.1)** — "@devswarm" initiates from
  any channel the leader can hear; no dedicated identity.
- The `["swarm", <id>]` tag now exists on *initiating* messages by design;
  whether the leader's assignment replies should also carry it (swarm
  activity view) stays open — cheap to add later.
- CLI surface (`buzz swarms get/set`) — follows the AGENTS.md rule
  (agent-facing ops live in buzz-cli); natural P5 if operators want to
  define swarms from the box.
