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

- [ ] **`getMentionableAgentPubkeys` learns a third input.** Append an
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

- [ ] **T1.1 New-DM recipient picker drops connected agents** (the reported
  bug). Gate: `candidate.isAgent && !eligibleAgentPubkeys.has(pubkey)`.
  - Anchor: `desktop/src/features/messages/ui/useNewMessageRecipients.ts:131`
  - Fix: feed F0 with `collectVerifiedAgentPubkeys(userSearchResults)`.
  - Merge path: **~2 contained lines** in one hook + cases in its existing
    test file. No UI edits (`NewMessageScreen` adds no gate of its own).
  - Caveat to carry into UX copy someday: buzz-acp DM-hardening means the
    agent replies only to its owner in DMs (`crates/buzz-acp/src/lib.rs:4774`)
    — same as already-listed directory agents, so parity is still correct.
- [ ] **T1.2 Global search deletes connected agents** — unfindable by name
  app-wide; the verified tag is what trips the drop.
  - Anchor: `desktop/src/features/search/useSearchResults.ts:287-328` (drop at `:326`)
  - Fix: same F0 union (search results are `UserSearchResult`s — reuse
    `collectVerifiedAgentPubkeys` on the result set itself).
  - Merge path: **~2 contained lines**; add the first test for this gate.
- [ ] **T1.3 Huddle "Add Agent" dialog is managed+running only**, though the
  backend is just a kind:9000 `role=bot` publish a standalone harness picks
  up live (`desktop/src-tauri/src/huddle/agents.rs:6-8,84`); TTS/participants/
  remove are already role-based.
  - Anchor: `desktop/src/features/huddle/components/AddAgentDialog.tsx:44,53-55`
  - Fix: enumerate `managed(running) ∪ verified agents from user search`,
    with presence dots via `usePresenceQuery`.
  - Merge path: **new file** `features/huddle/useHuddleAgentCandidates.ts` +
    swap the dialog's `invoke` for the hook (~10 contained lines in a
    low-churn file).
- [ ] **T1.4 Channel "Add agents" dialog can't add an existing connected
  agent** — enumerates local personas + teams only, provisions
  `backend: local`.
  - Anchor: `desktop/src/features/channels/ui/AddChannelBotDialog.tsx:65-79,147-158`
  - Fix: an "Existing agents" section listing verified agents (member-add via
  the relay path the members picker already uses).
  - Merge path: **new component file** for the section + one insertion point
    in the dialog. Medium; do after F0. (Interim workaround exists: the
    members-sidebar picker already adds connected agents.)
- [ ] **T1.5 Projects "prompt an agent" picker** — `managed ∪ (directory ∩
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
- [ ] **T2.2 "Stop current turn" never offered for owned connected agents.**
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

- [ ] **T3.1 No Edit affordance for an owned connected agent** — the editor
  exists but is reachable only via Settings → Connected agents.
  - Anchor: `UserProfilePanel.tsx:327-329` (`canEditAgent`)
  - Fix: extract `EditAgentDialog` out of `ConnectedAgentsSettingsCard.tsx`
    into its own file (fork-authored file — free), then render it from the
    panel when `viewerIsOwner && !managedAgent`.
  - Merge path: **new file** (extraction) + **~4 lines** in
    `UserProfilePanel.tsx` (hot file — keep it to import/predicate/render).
- [ ] **T3.2 Owner-published instructions (kind:30177) invisible on the
  panel.** `useConnectedAgentDefinitionQuery` is consumed only by the
  settings card.
  - Anchor: `UserProfilePanelSections.tsx:232-234` (`showInstructionBlock`)
  - Merge path: contained — pass the definition text through the existing
    instruction-block prop rather than adding new sections.
- [ ] **T3.3 Channels tab always empty (with a misleading empty state).**
  Membership scan is `if (managedAgent && channels)`-gated even though
  membership is already in `channelsQuery.data`.
  - Anchor: `desktop/src/features/profile/ui/UserProfilePanelUtils.ts:116-147` (gate at `:133`)
  - Merge path: **one-line predicate** (`isBot && channels`) + test.
- [ ] **T3.4 "Add to channel" hidden for owned connected agents** — same
  over-restriction the members-picker fix removed elsewhere
  (`MembersSidebar.tsx:276-284` comment).
  - Anchor: `UserProfilePanel.tsx:785,867,913`
  - Fix: widen to `viewerIsOwner`; for non-managed agents submit the plain
    relay member-add (kind:9000) instead of the managed attach flow.
  - Merge path: contained; reuse the existing add-member mutation, no new
    dialog if `AddAgentToChannelDialog` is generalized to a pubkey.
- [ ] **T3.5 "View activity log" vanishes off channel routes for idle
  connected agents** — channel resolution comes from the 10100 entry only.
  - Anchor: `desktop/src/features/agents/useOpenAgentActivity.ts:89-136`
  - Fix: fold in channel membership (`channels[].memberPubkeys`) as a third
    channel-id source, as `useManagedAgentActions.ts:120-131` does for
    managed agents.
  - Merge path: **contained edit in one hook** + its existing test file.
- [ ] **T3.6 Observer ingestion cold-start seed.** Ingestion is correctly
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

- [ ] **T4.1 Agents page shows zero trace of connected agents.**
  - Anchor: `desktop/src/features/agents/ui/AgentsView.tsx:153-210`
  - Fix: a "Connected" section reusing the settings-card enumeration
    (share via the T3.1 extraction).
  - Merge path: **new component file** + one insertion line.
- [ ] **T4.2 Pulse treats connected agents as humans.** Agents-tab timeline,
  tab count, People-tab exclusion, "No agents registered yet" copy, and
  NoteCard badges all key off `managed ∪ directory`; composer mentions drop
  them (non-member managed-list gate).
  - Anchors: `desktop/src/features/pulse/ui/PulseView.tsx:93-168,215-216,312`,
    `PulseTabBar.tsx:105-109`, `desktop/src/features/messages/lib/useMentions.ts:241-246`
  - Merge path: contained edits inside `PulseView` (fold
    `profiles[pk].isAgent` into `agentPubkeySet`; it already fetches the
    profiles); the composer-mention half rides F0.
- [ ] **T4.3 Sidebar working tooltip degrades to "1 agent working"** — names
  resolve from managed agents only.
  - Anchor: `desktop/src/features/sidebar/lib/useActiveWorkingChannelsById.ts:8-33`
  - Merge path: contained — fall back to the batch-profile displayName.
- [ ] **T4.4 (not connected-specific) member rows lack owner attribution;
  message-menu Ban/Timeout contradicts the sidebar's agent exemption.**
  - Anchors: `MembersSidebarMemberCard.tsx:160-238` (owner line),
    `features/moderation/ui/MessageModerationMenuItems.tsx:42-104` vs
    `MembersSidebarMemberCard.tsx:154-155`
  - Merge path: optional polish; contained edits. Low priority.

## Design limits (deliberate — revisit only with a design change)

- **Teams are persona-ID rosters end-to-end** (`shared/api/types.ts:831-836`)
  — connected agents can't join a team without a data-model change.
- **Start/stop/logs/delete stay managed-only** — no local process to control.
  The connected-agent equivalents are the control-frame paths (cancel-turn,
  set_profile) and Archive.
- **DM hardening**: standalone agents answer only their owner in DMs
  regardless of `respond_to` — a harness guarantee, not a UI bug.
- **Mobile/web parity**: no auth-tag verification outside the desktop Rust
  layer yet (`mobile/lib/shared/relay/nostr_models.dart`). Tracked upstream
  in `docs/first-class-member-agents.md` §7.

## Dead code exposed by the audit (cleanup, separate PR)

`ChannelMemberInviteCard.tsx`, `MembersSidebarAgentControls.tsx`,
`RecentNotesSection.tsx` — no importers (verified repo-wide). Note the first
also carries a latent role-defaulting bug; deletion moots it.

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
