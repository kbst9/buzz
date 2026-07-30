# Connected-Agent Parity Tracker

> **Fork-local (deploy branch only — never upstream this file.)** Individual
> fixes below *are* upstream candidates; this tracker is not.

Audit date: 2026-07-28 (desktop @ `deploy`, all anchors verified against that
tree). Scope: every desktop surface that enumerates or classifies agents,
checked for whether a **connected agent** — standalone harness, auth-tagged
kind:0, relay member, not desktop-managed, not in the kind:10100 directory —
is on equal footing with a **local (managed) agent**.

## Root causes (two patterns explain every gap)

- **Pattern A — stale enumeration.** Surfaces that build agent *lists* from
  `managed ∪ kind:10100 directory`. Connected agents are in neither source;
  they arrive correctly classified via user search / batch profiles / member
  rows (`isAgent` from the verified NIP-OA tag) and get dropped or never
  consulted.
- **Pattern B — role-only member gates.** Checks of `member.role === "bot"`
  that ignore the verified `member.isAgent`. Reachable because invite-claimed
  agents get relay role `member` (`crates/buzz-db/src/relay_invite.rs:193`)
  and `buzz channels add-member` emits no role tag by default
  (`crates/buzz-sdk/src/builders.rs:575`); only the desktop picker assigns
  `bot` (`MembersSidebar.tsx:584`).

## Maintenance strategy (why each item names a "merge path")

This fork tracks upstream `block/buzz` continuously (`buzz-sync`; rerere
replays resolutions). To keep that cheap:

1. **Upstream-first.** Every fix ships as a single-concern `feat/*` branch off
   `main` → upstream PR. A merged PR is a fork delta that disappears.
2. **Until merged, minimize conflict surface**, in order of preference:
   **new files** (never conflict) > **append-only exports** to small stable
   files > **single-line edits** in hot files. Known hot files to avoid
   rewriting: `ChannelScreen.tsx`, `ChannelPane.tsx`, `UserProfilePanel.tsx`,
   `MembersSidebar.tsx`, `AppShell.tsx`.
3. `ConnectedAgentsSettingsCard.tsx` and everything under
   `features/agents/lib/connectedAgent*` are **fork-authored** — free to
   restructure, zero merge risk today (they become shared once upstreamed).
4. Shared plumbing first: most Tier 1 items want the same helper (see F0), so
   land F0 once and the rest become one-line call-site edits.

Status legend: `[ ]` open · `[x]` done (commit) · `[~]` partial · `[–]` won't fix.

---

## F0 — shared eligibility plumbing (prerequisite for Tier 1)

- [x] **`getMentionableAgentPubkeys` learns a third input.** **Done:**
  `1f4fa959` (`feat/connected-agent-picker-eligibility`). Append an
  optional `verifiedAgentPubkeys?: ReadonlySet<string>` param (default empty)
  unioned into the result, plus a sibling helper
  `collectVerifiedAgentPubkeys(users)` that extracts auth-tagged agents from
  `UserSearchResult[]`/profile lookups.
  - Anchor: `desktop/src/features/agents/lib/agentAutocompleteEligibility.ts:33-55`
  - Merge path: **append-only** exports in a small, stable, fork-familiar
    file (upstream churn low; we already patched it in #1611-era work).
    Optional trailing param keeps every existing upstream call site
    compiling unchanged — no signature conflicts.
  - Semantics: mirror the mention picker's "Option B" (member/verified agents
    show unless an explicit won't-respond-to-me allowlist excludes you) —
    precedent at `agentAutocompleteEligibility.ts:73-122`.

## Tier 1 — connected agent unreachable (Pattern A)

- [x] **T1.1 New-DM recipient picker drops connected agents** **Done:**
  `1f4fa959`. (the reported
  bug). Gate: `candidate.isAgent && !eligibleAgentPubkeys.has(pubkey)`.
  - Anchor: `desktop/src/features/messages/ui/useNewMessageRecipients.ts:131`
  - Fix: feed F0 with `collectVerifiedAgentPubkeys(userSearchResults)`.
  - Merge path: **~2 contained lines** in one hook + a **new test file**
    (the hook has none today). No UI edits (`NewMessageScreen` adds no gate
    of its own).
  - Caveat to carry into UX copy someday: buzz-acp DM-hardening means the
    agent replies only to its owner in DMs (`crates/buzz-acp/src/lib.rs:4774`)
    — same as already-listed directory agents, so parity is still correct.
- [x] **T1.2 Global search deletes connected agents** **Done:** `1f4fa959`. — unfindable by name
  app-wide; the verified tag is what trips the drop.
  - Anchor: `desktop/src/features/search/useSearchResults.ts:287-328` (drop at `:326`)
  - Fix: same F0 union (search results are `UserSearchResult`s — reuse
    `collectVerifiedAgentPubkeys` on the result set itself).
  - Merge path: **~2 contained lines**; add the first test for this gate.
- [x] **T1.3 Huddle "Add Agent" dialog is managed+running only** **Done:**
  `1791fe13` (`feat/huddle-add-connected-agents`)., though the
  backend is just a kind:9000 `role=bot` publish a standalone harness picks
  up live (`desktop/src-tauri/src/huddle/agents.rs:6-8,84`); TTS/participants/
  remove are already role-based.
  - Anchor: `desktop/src/features/huddle/components/AddAgentDialog.tsx:44,53-55`
  - Fix: enumerate `managed(running) ∪ verified agents from user search`,
    with presence dots via `usePresenceQuery`.
  - Merge path: **new file** `features/huddle/useHuddleAgentCandidates.ts` +
    swap the dialog's `invoke` for the hook (~10 contained lines in a
    low-churn file).
- [x] **T1.4 Channel "Add agents" dialog can't add an existing connected
  agent** **Done:** `b8daa18e` (`feat/channel-add-existing-agents`). — enumerates local personas + teams only, provisions
  `backend: local`.
  - Anchor: `desktop/src/features/channels/ui/AddChannelBotDialog.tsx:65-79,147-158`
  - Fix: an "Existing agents" section listing verified agents (member-add via
  the relay path the members picker already uses).
  - Merge path: **new component file** for the section + one insertion point
    in the dialog. Medium; do after F0. (Interim workaround exists: the
    members-sidebar picker already adds connected agents.)
- [x] **T1.5 Projects "prompt an agent" picker** **Done:** `1f4fa959`. — `managed ∪ (directory ∩
  mentionable)`; user search never consulted.
  - Anchor: `desktop/src/features/projects/ui/ProjectsAgentPromptPage.tsx:128-175`
  - Fix: append verified agents (owned first) to `useAgentCandidates`.
  - Merge path: **contained edit** inside one function + F0 helper.

## Tier 2 — in the channel but silent/misrendered (Pattern B)

- [x] **T2.1 Channel session roster ignores `member.isAgent`** — the crux
  line; everything indented below falls out of it. **Done:** `d1cc2a4a`
  (branch `feat/connected-agent-session-roster`, merged to deploy; upstream
  PR candidate).
  - Anchor: `desktop/src/features/channels/ui/useChannelAgentSessions.ts:93`
    (candidates) and `:127-133` (`botMemberPubkeys` re-filter)
  - Symptoms: typing renders as a *human* typing
    (`useChannelActivityTyping.ts:88-102`) and never feeds the bot-typing
    fallback of the working signal (so observer-off connected agents have no
    working indicator at all); composer BotActivityBar stays empty while
    observer turns stream (`BotActivityBar.tsx:47-53`); "View activity" from
    the members sidebar opens-then-auto-closes and `?agentSession=` deep
    links get cleared (`useChannelAgentSessions.ts:292-310`).
  - Fix: admit members via `role === "bot" || member.isAgent === true` in
    both spots — the exact predicate `useClassifiedMembers.ts:34-50` and
    `mergeChannelKnownAgentPubkeys` already use.
  - Merge path: **two single-token-ish line edits** + a **new test file**
    (`useChannelAgentSessions.test.mjs`). Smallest possible delta in a
    medium-churn file.
- [x] **T2.2 "Stop current turn" never offered for owned connected agents.**
  **Done:** `f8593ee1` (`feat/connected-agent-stop-turn`).
  `canInterruptTurn` is hardcoded managed-only, but the actual transport is
  the same owner-gated kind:24200 control frame `set_profile` already uses
  for connected agents (`shared/api/agentControl.ts`).
  - Anchors: `useChannelAgentSessions.ts:85,102`,
    `desktop/src/features/channels/lib/agentSessionSelection.ts:41`,
    `AgentSessionThreadPanel.tsx:106,242-258`
  - Fix: set `canInterruptTurn` when the viewer verifiably owns the agent
    (profile `ownerPubkey === me`), threading the owner lookup into the two
    candidate builders.
  - Merge path: **contained edits in 2 files** + tests; do together with T2.1.

## Tier 3 — profile-panel owner management (predicates, not plumbing)

Classification on the panel is already right (badge, owner line, Memories,
in-channel session streaming). These are `managedAgent !== undefined` gates
that should be `viewerIsOwner` (already computed, NIP-OA-derived,
`UserProfilePanel.tsx:306,310`):

- [x] **T3.1 No Edit affordance for an owned connected agent** **Done:**
  `b020cbf3` (`feat/connected-agent-panel-parity`; dialog extracted to
  `ConnectedAgentEditDialog.tsx`). — the editor
  exists but is reachable only via Settings → Connected agents.
  - Anchor: `UserProfilePanel.tsx:327-329` (`canEditAgent`)
  - Fix: extract `EditAgentDialog` out of `ConnectedAgentsSettingsCard.tsx`
    into its own file (fork-authored file — free), then render it from the
    panel when `viewerIsOwner && !managedAgent`.
  - Merge path: **new file** (extraction) + **~4 lines** in
    `UserProfilePanel.tsx` (hot file — keep it to import/predicate/render).
- [x] **T3.2 Owner-published instructions (kind:30177) invisible on the
  panel.** **Done:** `d1cc6b3b`. `useConnectedAgentDefinitionQuery` is consumed only by the
  settings card.
  - Anchor: `UserProfilePanelSections.tsx:232-234` (`showInstructionBlock`)
  - Merge path: contained — pass the definition text through the existing
    instruction-block prop rather than adding new sections.
- [x] **T3.3 Channels tab always empty (with a misleading empty state).**
  **Done:** `67c6e0ed`.
  Membership scan is `if (managedAgent && channels)`-gated even though
  membership is already in `channelsQuery.data`.
  - Anchor: `desktop/src/features/profile/ui/UserProfilePanelUtils.ts:116-147` (gate at `:133`)
  - Merge path: **one-line predicate** (`isBot && channels`) + test.
- [x] **T3.4 "Add to channel" hidden for owned connected agents** **Done:**
  `aad9f78b` (dialog generalized to a pubkey target; relay add via the
  members-sidebar mutation, refusals surfaced inline). — same
  over-restriction the members-picker fix removed elsewhere
  (`MembersSidebar.tsx:276-284` comment).
  - Anchor: `UserProfilePanel.tsx:785,867,913`
  - Fix: widen to `viewerIsOwner`; for non-managed agents submit the plain
    relay member-add (kind:9000) instead of the managed attach flow.
  - Merge path: contained; reuse the existing add-member mutation, no new
    dialog if `AddAgentToChannelDialog` is generalized to a pubkey.
- [x] **T3.5 "View activity log" vanishes off channel routes for idle
  connected agents** **Done:** `8dd2e4b4` (membership as a channel-id
  source via `collectAgentMemberChannelIds`). — channel resolution comes from the 10100 entry only.
  - Anchor: `desktop/src/features/agents/useOpenAgentActivity.ts:89-136`
  - Fix: fold in channel membership (`channels[].memberPubkeys`) as a third
    channel-id source, as `useManagedAgentActions.ts:120-131` does for
    managed agents.
  - Merge path: **contained edit in one hook** + its existing test file.
- [x] **T3.6 Observer ingestion cold-start seed.** **Done:** `9ae11b74`
  (`feat/observer-ingestion-seed`); seed now mounts inside
  `useAgentObserverIngestion` (size-guard fixup), so the AppShell delta is
  zero. Ingestion is correctly
  widened to verified-owned profiles but only sees profiles some other
  surface already loaded into the batch cache — frames stay undecrypted
  until then (self-heals; latent).
  - Anchor: `desktop/src/features/agents/useAgentObserverIngestion.ts:115-121`
  - Fix: a small hook that primes the cache from the user-search directory
    (the enumeration `ConnectedAgentsSettingsCard` already uses) once per
    community.
  - Merge path: **new file** + **1 mount line** in `AppShell.tsx` (hot file —
    single line only).

## Tier 4 — visibility & cosmetics

- [x] **T4.1 Agents page shows zero trace of connected agents.** **Done:**
  `5c8eccea` + `2e7d09a8` (`feat/agents-page-connected-section`).
  **Spec correction discovered while landing:** the live per-agent
  component on this page is `AgentIdentityCard` (via
  `UnifiedAgentsSection`), NOT `ManagedAgentRow` — the section renders
  through `AgentIdentityCard` on the shared grid with an additive
  `connected` prop (Cable icon); `ManagedAgentRow`/`AgentGroupRows` turned
  out to be orphaned (see Dead code).
  - Anchor: `desktop/src/features/agents/ui/AgentsView.tsx:153-210`
  - Fix: a "Connected" section reusing the settings-card enumeration
    (share via the T3.1 extraction).
  - **Design requirement (Kevin): connected agents must look exactly like
    the other agents on this page — same row component, same layout — with
    only a small icon marking them as connected** (the `Cable` icon the
    settings card already uses is the natural glyph). Concretely: render
    them through `ManagedAgentRow` by synthesizing a `ManagedAgent`-shaped
    record per connected agent (the `profileActivityAgent.ts:25-43`
    precedent; e.g. `backend: {type: "provider", id: "connected"}`) —
    managed-only chrome already self-gates on `backend.type !== "local"`
    (`ManagedAgentRow.tsx:58`), so the row needs only the icon conditional
    and an owner line. Do NOT build a separate card design.
  - Merge path: **new component file** (section + record synthesis) + one
    insertion line in `AgentsView` + a small icon conditional inside
    `ManagedAgentRow`.
- [x] **T4.2 Pulse treats connected agents as humans.** **Done:**
  `355e016f` (`feat/pulse-connected-agents`, stacked on F0). Tab count now
  derives from the same widened set as the timeline; release-note the
  People→Agents re-bucketing. Agents-tab timeline,
  tab count, People-tab exclusion, "No agents registered yet" copy, and
  NoteCard badges all key off `managed ∪ directory`; composer mentions drop
  them (non-member managed-list gate).
  - Anchors: `desktop/src/features/pulse/ui/PulseView.tsx:93-168,215-216,312`,
    `PulseTabBar.tsx:105-109`, `desktop/src/features/messages/lib/useMentions.ts:241-246`
  - Merge path: contained edits inside `PulseView` (fold
    `profiles[pk].isAgent` into `agentPubkeySet`; it already fetches the
    profiles); the composer-mention half rides F0.
- [x] **T4.3 Sidebar working tooltip degrades to "1 agent working"** **Done:**
  `9d935652` (`feat/sidebar-working-agent-names`). — names
  resolve from managed agents only.
  - Anchor: `desktop/src/features/sidebar/lib/useActiveWorkingChannelsById.ts:8-33`
  - Merge path: contained — fall back to the batch-profile displayName.
- [x] **T4.4 (not connected-specific) member rows lack owner attribution;
  message-menu Ban/Timeout contradicts the sidebar's agent exemption.**
  **Done:** `14d4bcf0` (owner line) + `40e3d84b` (restrict items withheld
  for agent authors; kick retained, mirroring the sidebar). Product
  sign-off: Kevin's 2026-07-29 "do this all" directive.
  - Anchors: `MembersSidebarMemberCard.tsx:160-238` (owner line),
    `features/moderation/ui/MessageModerationMenuItems.tsx:42-104` vs
    `MembersSidebarMemberCard.tsx:154-155`
  - Merge path: optional polish; contained edits. Low priority.

## Blast radius per fix

Shared invariants first: **every fix is desktop-frontend only** — no relay,
mobile, CLI, or migration changes anywhere (T1.3/T1.4/T3.4 *publish* an
existing event kind, kind:9000, through relay policy that already governs
it). Classification always derives from the Rust-verified NIP-OA tag, so
none of these let a self-authored profile flag spoof agent-ness. One shared
data dependency: frontend `member.isAgent` is enriched by the member-list
command's profile overlay (`desktop/src-tauri/src/commands/channels.rs:446-456`);
if its batch kind:0 query fails it silently degrades to role-only for that
fetch (`unwrap_or_default`) and role-gated behavior returns until a refetch
— T2.1/T2.2 inherit this, nothing else does.

- **F0 (eligibility third input)** — Touches: append-only exports in
  `agentAutocompleteEligibility.ts` (+ its existing test file).
  Runtime radius: **zero until a call site opts in** — the changed function
  is consumed by exactly three hooks (`useMentions`,
  `useNewMessageRecipients`, `ProjectsAgentPromptPage`), each of which only
  changes when it passes the new set (T1.1/T1.5/T4.2). Risk: a too-broad
  verified set would offer agents that won't respond; bounded by Option B
  semantics and covered by unit tests.
- **T1.1 (DM picker)** — Touches: `useNewMessageRecipients.ts` (~2 lines) +
  new test file. Runtime radius: recipient candidates for every user of New
  Message/compose; connected agents appear (chip metadata: `isAgent`, owner
  attribution already rendered by `NewMessageResultRow`). Behavioral note:
  non-owners can now start a DM the agent won't answer (harness DM
  hardening) — identical to already-listed directory agents, so no new
  inconsistency. Risk: low; candidate dedupe/coalesce paths already handle
  agent entries; hook previously untested.
- **T1.2 (global search)** — Touches: `useSearchResults.ts` (~2 lines) +
  first test for the gate. Runtime radius: identity results for everyone —
  connected agents become findable, routed to the "agents" section with the
  Bot icon (`TopbarSearch`/`SearchResultItem` need no edits). No
  cross-community exposure: user search is relay-scoped. Risk: low, but
  this is the app-wide search surface — regression here is highly visible,
  hence the new test.
- **T1.3 (huddle add)** — Touches: new `useHuddleAgentCandidates.ts` +
  ~10 lines in `AddAgentDialog.tsx`. Runtime radius: huddle add-list only;
  selecting a connected agent publishes kind:9000 `role=bot` to the
  ephemeral+parent channels — the already-shipped backend path
  (`huddle/agents.rs`); TTS/participants/remove pick it up role-based with
  no changes. Risk: offering an offline agent that never joins — mitigated
  by the presence dot; huddle UX otherwise untouched.
- **T1.4 (channel Add-agents dialog)** — Touches: new section component +
  one insertion in `AddChannelBotDialog.tsx`. Runtime radius: that dialog
  only; adds via the relay member-add path (subject to
  `channel_add_policy`, refusals surface like the members picker). The
  persona/team provisioning flow is untouched. Risk: low-medium (dialog
  state handling), no shared consumers.
- **T1.5 (Projects picker)** — Touches: `useAgentCandidates()` inside
  `ProjectsAgentPromptPage.tsx` (sole consumer). Runtime radius: Projects
  prompt page agent list. Same non-owner DM-hardening caveat as T1.1.
  Risk: minimal.
- **T2.1 (session roster — LANDED `d1cc2a4a`)** — Touched: two predicates
  in `useChannelAgentSessions.ts` + new 6-case test file. Runtime radius —
  the widest of the set, for **all viewers** of any channel/DM containing a
  verified member-role agent: typing reclassifies from the human typing row
  to the bot activity accessory; composer/thread activity chips can now
  show the agent; members-sidebar "View activity" stops auto-closing;
  `?agentSession=` deep links survive. Consumers of the changed functions:
  `useChannelAgentSessions` itself, `useChannelActivityTyping` (whose
  `reportChannelBotTyping` mirror now feeds the working signal → sidebar
  badges), `BotActivityBar`/`ChannelPane` rosters. Risk assessed low: the
  admitting flag is the Rust-verified one, and the identical predicate has
  been in production in `useClassifiedMembers` since the members-sidebar
  fix. Verified by full desktop suite (3773 green).
- **T2.2 (stop-turn for owned connected agents)** — Touches:
  `agentSessionSelection.ts` + `useChannelAgentSessions.ts` (ownership
  threading) + tests. Runtime radius: owners only (button renders off
  `canInterruptTurn && isWorking`); press sends the owner-signed kind:24200
  cancel frame the harness already verifies (freshness-windowed, same
  transport as `set_profile`). Risk: harness builds predating control
  frames ignore it — button times out gracefully; non-owners see no change.
- **T3.1 (panel Edit dialog)** — Touches: extraction of `EditAgentDialog`
  into a new file (from the fork-owned settings card — zero upstream merge
  risk) + ~4 lines in `UserProfilePanel.tsx`. Runtime radius: owned
  connected agents' profile panels gain Edit; save paths are exactly the
  settings card's (kind:30177 publish + live `set_profile` frame) — no new
  write paths. Risk: predicate discipline (`viewerIsOwner`, not `isBot`) so
  non-owners never see Edit; hot-file edit kept minimal.
- **T3.2 (instructions on panel)** — Touches: `UserProfilePanelSections`
  predicate + wiring `useConnectedAgentDefinitionQuery`. Runtime radius:
  owner-only block on the panel; one extra cached query per panel open.
  Risk: minimal.
- **T3.3 (channels tab)** — Touches: one predicate in
  `UserProfilePanelUtils.ts` + test. Runtime radius: profile-panel Channels
  tab for all viewers of any agent — it now lists memberships already
  public in `channelsQuery` instead of a false empty state. Risk: nil.
- **T3.4 (add-to-channel from panel)** — Touches: `UserProfilePanel.tsx`
  predicate + a relay-add branch (reuse the members-picker mutation +
  error surfacing). Runtime radius: owner affordance; the add itself is
  relay-policed (`channel_add_policy`) so no new authority is granted
  client-side. Risk: needs the refusal toast wired or failures are silent.
- **T3.5 (activity off channel routes)** — Touches:
  `useOpenAgentActivity.ts` (+ its test file). Runtime radius: consumers
  are the profile panel, popover, and members sidebar — "View activity"
  becomes available for idle owned connected agents everywhere. Risk: worst
  case is opening a session panel for a channel the agent has left; the
  existing roster guard already closes that benignly.
- **T3.6 (cold-start decrypt seed)** — Touches: new hook file + **one
  mount line in `AppShell.tsx`** (the only hot-file edit in Tier 3, kept to
  a line). Runtime radius: one paged user-search query per community boot;
  effect is invisible except that owned connected agents' observer frames
  decrypt from app start instead of after their profile happens to load.
  Risk: startup network cost only; ingestion dedup already handles overlap.
- **T4.1 (Agents page section)** — Touches: new component (section +
  synthesized `ManagedAgent`-shaped records) + one insertion in
  `AgentsView.tsx` + a small connected-icon conditional in
  `ManagedAgentRow.tsx`. Runtime radius: Agents page for everyone;
  connected rows render through the exact same component as managed ones
  (per design requirement), so visual drift between the two is structurally
  impossible; managed-only chrome (logs) already self-gates on
  `backend.type`. Risk: the `ManagedAgentRow` edit is shared with managed
  rows — keep it to the icon conditional so managed rendering is
  byte-identical when the flag is absent.
- **T4.2 (Pulse)** — Touches: contained edits in `PulseView.tsx` (+
  `PulseTabBar` count; composer half rides F0 in `useMentions`). Runtime
  radius: **visible content re-bucketing for everyone** — connected
  agents' notes move from the People tab to the Agents tab, badges/counts
  change, agent notes get bot styling. Flag in release notes; it will read
  as "posts moved". Risk: tab-count/copy regressions; no data changes.
- **T4.3 (sidebar tooltip names)** — Touches:
  `useActiveWorkingChannelsById.ts`. Runtime radius: tooltip copy only
  ("Nova working" instead of "1 agent working"). Risk: nil.
- **T4.4 (owner line + moderation-menu alignment)** — Touches:
  `MembersSidebarMemberCard` (additive owner label) and
  `MessageModerationMenuItems` (gate Ban/Timeout off `message.isAgent`).
  Runtime radius: the second half **removes an affordance moderators
  currently have** on agent-authored messages (aligning with the members
  sidebar's existing exemption) — product sign-off before landing; applies
  to managed and connected agents alike. Risk: policy, not code.
- **Dead-code deletion** (`ChannelMemberInviteCard`,
  `MembersSidebarAgentControls`, `RecentNotesSection`) — Runtime radius:
  none (no importers; re-verify at delete time). Merge radius: deletions
  can conflict if upstream later touches those files — trivial "keep
  deleted" resolutions, and rerere remembers.

## Design limits (deliberate — revisit only with a design change)

- **Teams are persona-ID rosters end-to-end** (`shared/api/types.ts:831-836`)
  — connected agents can't join a team without a data-model change.
  **Resolution 2026-07-29:** Teams stays untouched; the delegation use case
  ships as the parallel **Swarms** feature instead — see `docs/swarms.md`.
- **Start/stop/logs/delete stay managed-only** — no local process to control.
  The connected-agent equivalents are the control-frame paths (cancel-turn,
  set_profile) and Archive.
- **DM hardening**: standalone agents answer only their owner in DMs
  regardless of `respond_to` — a harness guarantee, not a UI bug.
- **Mobile/web parity**: no auth-tag verification outside the desktop Rust
  layer yet (`mobile/lib/shared/relay/nostr_models.dart`). Tracked upstream
  in `docs/first-class-member-agents.md` §7.

## Dead code exposed by the audit (cleanup, separate PR)

**Done:** `a68e239e` (`chore/remove-orphaned-agent-components`) — all three
deleted after re-verification (e2e testid references checked; absence
assertions unaffected); `respondToAllowlist.ts` comment updated.

**New orphans found while landing T4.1** (follow-up, same treatment):
`ManagedAgentRow.tsx` and `AgentGroupRows.tsx` — the Agents page renders
`AgentIdentityCard` via `UnifiedAgentsSection`; the row components have no
live importer. Verify + delete in a future sweep.

## Already at parity (don't re-fix)

Channel @-mentions (member-aware Option B, #1611); members-sidebar add picker
(relay-authoritative); timeline/message badges + owner labels
(`formatTimelineMessages.ts:430`); member classification
(`useClassifiedMembers.ts:34-50`); home inbox (`HomeView.tsx:343-354` — the
reference widening pattern); PR add-reviewer; profile classification /
Memories / in-channel session streaming; sidebar moderation exemption;
Rust-side `ProfileInfo.is_agent`; observer ingestion enumeration
(`useAgentObserverIngestion.ts` — modulo the T3.6 seed).

---

## Thinking traces for connected agents (live enablement)

*(section maintained as work lands — see status below)*

**Goal:** an owned connected agent streams its live transcript (thoughts,
tool calls) into the app the same way a managed agent does: working badge →
channel activity chip → session transcript panel.

**How the pipeline works** (all shipped on this branch):

1. Unit env sets `BUZZ_ACP_RELAY_OBSERVER=true` → buzz-acp publishes
   NIP-44-encrypted kind:24200 frames `#p`-addressed to the NIP-OA owner.
2. Desktop ingestion registers every agent whose verified profile owner is
   the current identity (`useAgentObserverIngestion.ts` — directory no longer
   the sole source) and decrypts into the observer/turn stores.
3. Rendering: sidebar badge + profile-panel transcript are pubkey/owner-keyed
   and work; the in-channel activity chip and typing classification require
   T2.1 (role-only roster) — the one desktop fix trace parity depends on.

**Ops state (gradient, prod "Dreadnought" community):** all five standalone
units (`buzz-acp-{claude,codex,hermes,hermesgpt,threemes}`) have had
`BUZZ_ACP_RELAY_OBSERVER=true` since 2026-07-28's first-class-member-agents
rollout.

**2026-07-29:** all five units upgraded to the deploy-tip harness
(`b86fa114`, includes the kind:30177 instructions fetch) — saved
Instructions now apply at each agent's next session. Rollback binary:
`~/buzz-backups/bin-20260729-0350/` on gradient. Ops gotcha recorded: `just
ci` does not produce release binaries; build `-p buzz-acp --release` at the
intended commit right before installing.

**Status: VERIFIED end-to-end 2026-07-29** (harness → relay; desktop
rendering unblocked by T2.1):

- All five units log `relay observer enabled` on every start; **zero**
  observer publish warnings since the 07-28 rollout.
- Live turn exercised against `buzz-acp-claude` ("Moooclaude",
  `7fe4c46d…`): a DM sent *as the codex sibling* with an `@Moooclaude`
  mention fired the turn — the debug journal shows
  `sibling verified via NIP-OA` (owner `a2c1dab1…`) → `dispatch_pending
  dispatched=1` → `idle clock reset: tool call started` → ~25 relay-accepted
  publishes inside the 7-second turn window (reply + typing + kind:24200
  observer frames), and the reply landed in the DM 6 s after the mention.
  Repeated twice (22:25Z and 22:30Z turns; DM channel
  `39e1c215-1cc0-41eb-b177-ee038fba4fc6` holds the exchange).
- What the desktop shows for these agents (owner identity, after a rebuild
  containing `d1cc2a4a`): sidebar working badge during a turn, agent-styled
  typing, the composer activity chip, and the live transcript in the
  profile panel / channel session panel — same surfaces as a managed agent.
  Remaining trace-adjacent gaps are T2.2 (stop-turn button), T3.5
  (activity entry point off channel routes), T3.6 (cold-start decrypt
  seed), T4.3 (sidebar tooltip name).

**Ops notes learned during verification:**

- **A healthy buzz-acp turn is journal-silent at the default info level** —
  gate decisions, dispatch, and every publish ack log at debug. Don't
  diagnose "agent didn't respond" from an empty journal; drop in
  `Environment=RUST_LOG=buzz_acp=debug` via a runtime override
  (`/run/systemd/system/buzz-acp-<name>.service.d/`) and restart, or watch
  the observer pane in the app.
- **The default Mentions subscribe mode requires a p-tag even in DMs.** App
  clients auto-p-tag DM participants so this is invisible in normal use,
  but bare CLI sends (`buzz messages send`) must carry an `@Name` mention
  or the harness never sees the event.
- `sudo /tmp/buzz-as-agent.sh <unit> <buzz args…>` on gradient runs the CLI
  as any unit's identity. If /tmp was cleared, recreate it: a 10-line sh
  script that `grep|cut -d= -f2-` extracts `BUZZ_PRIVATE_KEY`,
  `BUZZ_RELAY_URL`, `BUZZ_AUTH_TAG` from `/etc/buzz-agents/<unit>.env`,
  exports them, and `exec`s `~/buzz/target/release/buzz "$@"`. (Plain
  `. file` sourcing corrupts the unquoted auth-tag JSON — sh eats its
  inner double quotes.)
