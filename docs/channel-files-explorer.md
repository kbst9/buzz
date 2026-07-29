# Channel Files Explorer (NIP-94 File Index)

Implementation plan for a file explorer in the desktop app — per channel, plus
a community-wide view — backed by a relay-derived index of kind `1063`
(NIP-94 file metadata) events, with a matching `buzz files` CLI surface so
agents can discover channel files without paging through message history.

Status: **implemented** on `feat/file-index-nip94` (relay emitter +
cascades, buzz-admin backfill, `buzz files list` + base-prompt teaching,
desktop channel drawer + community explorer, mobile kind constant, unit +
E2E coverage). Design v2 superseded v1 after a trigger-interaction review
([Design revisions from v1](#design-revisions-from-v1)); implementation
deltas from v2 are in
[Implementation findings](#implementation-findings-post-v2). Outstanding:
the DB-backed integration suite (relay-side tests listed below) and the
staged rollout steps.

Motivation: agents currently learn about files only from URLs that appear in
their trigger message or thread context (`buzz-acp` pushes no attachment
history — `fetch_conversation_context` in `crates/buzz-acp/src/pool.rs`
returns context only for thread replies and DMs). Humans have no per-channel
file view at all. One index fixes both.

---

## Summary of decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backing store | Kind `1063` (NIP-94), one event per attachment per share | Already registered in `kind.rs:62` and relay-accepted; **zero kind-registry changes needed**. Standard Nostr, readable by third-party clients. |
| Who publishes | **Relay derives them** as a post-accept side effect; clients publish nothing | The relay validates every incoming `imeta` tag (`handlers/imeta.rs`, REST + WS) and already synthesizes derived events (`handlers/side_effects.rs`). Server-side derivation: no drift, uniform coverage of all senders incl. third-party, one place for lifecycle cascades, backfill reuses the live code path. |
| Signature | Relay keypair | Precedent: kinds 39000/39001/13534. Lets the relay retract its own entries via NIP-09. |
| `created_at` | **Emission time**, with the source message's timestamp in a `shared_at` tag | Inheriting message timestamps breaks the replica-fence invariant (migration `0021`) for backfill. Emission time keeps every insert fence-safe with no GUC games. Ordering: see [Ordering](#ordering-and-pagination). |
| Uploader attribution | Custom `uploader` tag — **deliberately not `p`** | `p` tags are mention-semantics-bearing across the stack (push matcher, notifications). A custom tag removes the entire question class instead of patching consumers. |
| Trigger compatibility | **No migrations, no trigger edits** — by construction | See [Events-table trigger analysis](#events-table-trigger-analysis): live emissions are shadowed by the organic insert they accompany; backfill skips TTL channels; no `p` tags means nothing for the push matcher to match. |
| Lifecycle | Emit-all + retract-missing on edit; cascade retraction on delete/moderation — all relay-side, via relay-signed kind-5 | The `(e, x)` idempotency key *is* the edit diff. Desktop already processes `KIND_DELETION` in timelines (`formatTimelineMessages.ts`, `relayChannelFilters.ts`) — the Files tab mirrors that. |
| Backfill | `buzz-admin files backfill` — insert-only (no fan-out), skips TTL channels, idempotent on `(e, x)`; **runs before the emitter is enabled** | Rollout order is load-bearing for ordering; see [Rollout](#rollout-order-load-bearing). |
| Scoping | `h` tag = channel; reads are always channel-scoped queries | Community view = client-side union over the user's channel memberships — **never an unscoped query** (leak risk if visibility rides `#h` scoping). |
| DMs | Excluded | Gift-wrap/DM-visibility privacy model conflict. |
| Agent surface | `buzz files list --channel <uuid>` + one `base_prompt.md` row | Makes the inventory discoverable to agents — the highest-leverage slice. |

## Upstream-maintainability profile

This feature is designed to be carried on a fork and PR'd upstream with
minimal friction:

- **No SQL migrations.** No new tables, no edits to upstream trigger
  functions (`0021` fence, `0022` TTL refresh, `0023` push gate are all
  untouched — see the trigger analysis).
- **No `buzz-core/kind.rs` changes.** 1063 already exists; `shared_at` /
  `uploader` are tags, not kinds.
- **Mostly new files.** Shared-surface edits are one-line call sites:
  side-effect dispatch (+1), moderation removal (+1), CLI surface guards
  (known fork hot spot, mechanical), `base_prompt.md` (+1 row),
  client kind-constant files (+1 line each). Desktop UI wiring touches
  three upstream-active files — `ChannelMembersBar.tsx` (one button),
  `ChannelScreen.tsx` (one right-panel state slot), `AppSidebar.tsx` (one
  nav case) — keep each edit to exactly that footprint.
- Two PRs: data plane + agent surface first, desktop UI second.

## Event design

One kind-1063 event per imeta attachment per accepted channel message:

```
kind: 1063
pubkey: <relay keypair>
created_at: <emission time>                    // fence-safe by construction
content: <filename, else imeta alt, else "">   // also powers FTS name search
tags:
  ["url",  "https://<relay>/media/<sha256>.<ext>"]
  ["m",    "<mime>"]
  ["x",    "<sha256>"]
  ["size", "<bytes>"]
  ["thumb" | "dim" | "blurhash" | "duration", …]  // pass-through when present
  ["filename", "<name>"]            // mirrors the imeta key when present
  ["h",    "<channel uuid>"]        // NIP-29 channel scope
  ["e",    "<source message event id>"]        // jump-to-message + cascade key
  ["shared_at", "<source message created_at>"] // display/sort timestamp
  ["uploader", "<hex pubkey>"]      // attribution WITHOUT p-tag semantics
```

- One event per *share*, not per unique blob; dedup-by-hash is UI sugar.
- Idempotency/cascade key: (`e` source message id, `x` blob hash).
- Retraction: relay-signed kind-5 with `e` tags referencing the 1063 event
  ids (standard NIP-09 shape the desktop timeline already understands).
- Filename quality note: desktop and mobile populate imeta `filename`;
  CLI-uploaded (i.e. agent-shared) files currently don't — they index with
  an empty name and label as the URL tail until the `buzz-cli`
  filename/generic-file fix lands (tracked separately). Soft dependency,
  not a blocker.

## Events-table trigger analysis

A relay-derived 1063 is a **new durable event producer**, and every
events-table trigger fires for it. This section is the v1→v2 diff in
miniature, and the checklist below must be re-run whenever a new derived
emitter is added.

| Trigger | Interaction | Why v2 is safe |
|---------|-------------|----------------|
| `0021` created_at fence floor (channel-bearing rows must not commit with old timestamps; **no in-band bypass by design**) | Backfill with inherited timestamps would violate the replica keyset-pagination proof | `created_at` = emission time everywhere; `shared_at` tag carries display time. No GUC exemptions, no proof erosion. |
| `0022` ephemeral-channel TTL refresh (every channel-scoped insert extends `ttl_deadline`) | Synthesized inserts would keep ephemeral channels alive | **Shadowing:** every live emission/retraction commits alongside the organic insert (message, edit, deletion) that *just* refreshed the deadline — the derived insert changes nothing. The only unshadowed producer is backfill, which **skips channels with `ttl_seconds` set** (retroactively indexing transient channels is low-value anyway). Residual: a moderation removal in a TTL channel may extend its deadline via the retraction insert if the moderation command itself isn't a channel-scoped insert — rare, bounded, accepted. |
| `0023` push match gate (enqueues matcher work for every durable insert in lease-holding communities, "every durable producer … covered") | File shares could enqueue matcher work; `p` tags could push-notify uploaders about their own files | No `p` tags → nothing mention-shaped to match. Residual enqueue cost is one no-op row per file share in lease-holding communities; backfill bulk-enqueues are one-time and throttleable (`--sleep-ms`). Test-gated: a file share must produce zero push notifications. |

**Checklist for any future derived-event emitter** (add to AGENTS.md when
this ships): audit the new producer against *every* events-table trigger
(fence, TTL refresh, push gate, and whatever lands after them); check
mention/notification machinery for tag semantics (`p`, `e`); check thread
counters don't key on the new events' `e` tags.

## Ordering and pagination

Relay pagination orders by `(created_at, id)` — the `id` tiebreak matters
because a multi-attachment message emits several entries in one moment.

Global `created_at` order ≡ share order by construction: backfill runs
**before** the emitter is enabled (no live entries exist yet) and walks
messages oldest→newest, stamping monotonically increasing emission times;
live entries then begin strictly after. A second, post-enable backfill pass
catches messages sent during the first pass (idempotent; stragglers land
slightly out of order, bounded by the gap window). Clients additionally
re-sort fetched pages by `shared_at` for display, which absorbs any seam.

## Changes by component

### A. `buzz-relay` — the data plane (no client publisher changes)

1. **New module `handlers/file_index.rs`**:
   - `emit_file_index_events(state, tenant, &message_event)` — for each valid
     imeta tag on an accepted channel-message kind, build + sign + store +
     fan out a 1063. No re-validation (ingest already ran
     `validate_imeta_tags` / `verify_imeta_blobs`). No per-attachment
     existence check on this hot path — dispatch is post-accept and
     deduplicated upstream (verify exactly-once during implementation; the
     backfill/reconcile pass repairs any crash-window gaps).
   - `retract_file_index_events(state, tenant, message_id, keep_hashes)` —
     look up index entries by `e` tag, publish one relay-signed kind-5 for
     those whose `x` ∉ `keep_hashes`, store + fan out.
   - Edit handling = `emit_file_index_events` (dedup makes kept attachments
     no-ops, new ones emit) + `retract_file_index_events` with the edit's
     hash set. **The idempotency key is the diff** — no imeta-chain
     reconstruction.
2. **Hook sites** (one-line calls):
   - Post-accept side-effect dispatch (`handle_side_effects` call site,
     `handlers/ingest.rs:2481`) — message accept and edit (40003).
   - NIP-09 message deletion accept path → cascade with empty `keep_hashes`.
   - Moderation message removal (`moderation_commands.rs`) → same cascade.
3. **Query path: none.** `{kinds:[1063], "#h":[…]}` rides generic tag
   indexing; the p-gate is satisfied (explicit `kinds`). Channel visibility
   must match message visibility — **proven by test, with named fallbacks**:
   if parity fails, either copy the source message's visibility-relevant
   columns onto the 1063 row, or add a channel-membership join to 1063
   reads. Do not ship UI before this test passes.
4. **Search (free win, verify):** `content` = filename, so if `buzz-search`
   FTS indexes kind 1063 (or gains it via its kind list), filename search
   costs nothing extra.

### B. `buzz-admin` — backfill + reconcile

`files backfill [--channel <uuid>] [--dry-run] [--sleep-ms <n>]`: walk
historical channel messages with imeta tags (batched keyset scan, direct DB),
run the same derivation fn with **insert-only** semantics — no pub/sub
fan-out (blasting open subscriptions with history is harmful; clients
refetch). Skips TTL channels. Idempotent on `(e, x)`, so re-runs double as
the reconcile/repair tool. Reports scanned / emitted / skipped counts.

### C. Desktop — the explorer UI

New feature module `desktop/src/features/files/` (no cross-feature imports;
shared bits via `shared/`). Data layer shared by both views: a
`useChannelFiles(channelId)` hook — react-query page fetch
(`kinds:[1063], #h`, `(created_at, id)` cursor) + live subscription append,
re-sorted by `shared_at`; processes incoming relay-signed kind-5 exactly as
the timeline does (existing `KIND_DELETION` plumbing) by dropping retracted
entries.

**v1 — channel Files drawer** (per-channel):

- **Header button**: added to the existing button group in
  `ChannelMembersBar.tsx` (members-count pill · huddle · kebab), placed
  left of the members trigger. Lucide `FolderOpen` icon,
  `data-testid="channel-files-trigger"`, `aria-label="View channel files"`,
  tooltip "Files". Follows the existing icon-button styling in that group.
- **Drawer**: `ChannelFilesSidebar`, rendered in the **same right-panel slot
  as `MembersSidebar`** in `ChannelScreen.tsx` (mirror
  `isMembersSidebarOpen` with `isFilesSidebarOpen`). The slot is exclusive:
  opening Files closes Members and vice versa (one boolean pair collapsed
  into a single `rightPanel: "members" | "files" | null` state is the
  cleaner refactor if `ChannelScreen` tolerates it; otherwise two mutually
  exclusive booleans). Esc and the drawer's close button dismiss it; width
  and chrome match `MembersSidebar`.
- **Drawer content**, top to bottom:
  - Title row: "Files" + total-so-far count + close button.
  - Filter row: client-side name search input + type chips
    (All / Images / Video / Audio / Docs) derived from the `m` tag.
  - Virtualized row list (newest first): thumbnail via `thumb` through the
    existing media proxy (Blossom get auth signed — works with
    `BUZZ_REQUIRE_MEDIA_GET_AUTH` on) or MIME-class icon fallback;
    filename from the `filename` tag (URL-tail hash fallback for nameless
    agent uploads); size; uploader chip via `uploader` tag + profile
    lookup; `shared_at` as relative time. Row click → jump to source
    message (`e` tag, existing deep-link path). Hover actions: download
    (restores original filename), copy link.
  - Infinite scroll on the `(created_at, id)` cursor; skeleton rows while
    loading; empty state ("No files shared in this channel yet").
  - All text on stock rem tokens (`text-sm` / `text-xs` / `text-2xs`) —
    no arbitrary px/rem literals (zoom rule + `check:px-text` CI guard).

**v1.1 — community Files screen** (top-level):

- **Sidebar entry**: extend the selected-view union in
  `AppSidebar.tsx` (`"workflows" | …`) with `"files"`; nav item labeled
  "Files" directly **below Workflows**, `FolderOpen` icon,
  `data-testid="sidebar-files"`, wired through an `onSelectFiles` callback
  like its siblings; the main-content switch renders
  `CommunityFilesScreen`.
- **`CommunityFilesScreen`**: one accordion section per channel the user is
  a member of (channel name + file-count-so-far badge), collapsed by
  default. **Expanding an accordion is what issues that channel's
  `useChannelFiles` query — the lazy-load IS the privacy model**: only
  membership-scoped, per-channel queries ever fire, the banned unscoped
  query has no code path, and unexpanded channels cost nothing. Within an
  expanded section: the same row list as the drawer. Screen-level type
  chips + name search apply to loaded sections (search input notes it
  covers expanded channels).
- DM channels are absent from the accordion list (DMs are unindexed by
  design).

Shared plumbing for both views:
- `desktop/src/shared/constants/kinds.ts`: add `1063`; keep
  `mobile/lib/shared/relay/nostr_models.dart` in sync (CLAUDE.md rule).
- Any new module-level cache must register in `resetCommunityState()`.
- E2E (mock-bridge 1063 emitter): drawer spec (trigger opens drawer,
  members/files exclusivity, filter, live append, retraction removes row)
  and community spec (nav item renders screen, accordion expand loads rows,
  **no query fires for unexpanded channels** — asserted via the mock
  bridge's request log, making the privacy property a tested invariant).

### D. `buzz-cli` + agent surface

- `buzz files list --channel <uuid> [--type image|video|audio|doc]
  [--limit N] [--before <ts>]` → sig-stripped JSON via `POST /query`.
  Update the surface-guard tests in `crates/buzz-cli/src/lib.rs` (names AND
  counts) — known `buzz-sync` rerere hot spot, mechanical.
- `base_prompt.md`: add `files` → `list` to the CLI table + one catch-up
  line; extend the `shared_base_prompt_teaches_*` test pattern.

### E. Mobile (parity, can trail)

Kind constant sync day one; Files tab later (Riverpod, `HookConsumerWidget`,
`lib/features/files/`).

## Privacy

- A private channel's file *listing* gates exactly as its messages do —
  enforced by the parity test, not assumed. The *blobs* remain
  community-readable (or world-readable with the media GET gate off); the UI
  must not imply blob-level channel privacy. See
  `docs/storage-config-desktop-admin.md` § Locked-down storage.
- Integration suite includes an **unscoped-query leak test**: a non-member's
  `{kinds:[1063]}` query (no `#h`) must not return private-channel entries.
- DM attachments are absent by design.

## Lifecycle invariant

> Any code path that deletes or edits channel messages must cascade to
> file-index entries (`retract_file_index_events`).

Mirrors the thread-counter materialization rule; add both this and the
trigger-audit checklist to AGENTS.md when the feature lands.

## Testing plan

- **Unit (relay):** imeta→1063 field mapping; `shared_at`/`uploader` tags;
  emit-all+retract-missing edit semantics; `(e, x)` idempotency.
- **Integration (`just test`):**
  - N-attachment message → N queryable 1063s; live subscriber receives them.
  - Edit removing one attachment → its entry retracted (kind-5 fanned),
    others intact; edit adding one → exactly one new entry.
  - Message deletion / moderation removal → full cascade.
  - **Private-channel parity** (gates the UI) + **unscoped-leak test**.
  - **No side-effect bleed:** a file share produces zero push notifications,
    zero mention notifications, zero thread-counter movement.
  - **TTL neutrality:** backfill leaves a TTL channel's `ttl_deadline`
    untouched (it skips); live share in a TTL channel doesn't extend the
    deadline beyond what its own message set.
  - Backfill: correct counts; second run → zero new; insert-only (no
    fan-out observed).
- **CLI:** surface-guard update; `files list` against seeded relay.
- **Desktop:** component tests (filters, empty state, nameless-file
  fallback label, thumb fallback) + the two E2E specs from §C — including
  the members/files drawer exclusivity and the no-query-before-expand
  assertion for unexpanded accordion channels.

## Rollout order (load-bearing)

1. ✅ Land relay emitter + CLI, **emitter feature-flagged off**
   (`BUZZ_FILE_INDEX`, default off).
2. Run `buzz-admin files backfill` to completion (ordering guarantee
   depends on backfill-before-enable).
3. Enable emitter (`BUZZ_FILE_INDEX=true`); run a second backfill pass for
   the gap window.
4. Ship the desktop UI (✅ code landed; deploy **after** the
   private-channel parity + unscoped-leak integration tests are green —
   they remain the gate).

## Out of scope (v1)

- Agent workspace manifests / live workspace browsing (separate design).
- DM file index.
- Dedup-by-hash UX, storage analytics.
- Channel-ACL enforcement on blobs (orthogonal; see media GET-auth work).

## Implementation findings (post-v2)

What implementation confirmed, changed, or simplified relative to the v2
design. Component ↔ commit map: `docs:` design → `feat(relay):` emitter →
`feat(admin):` backfill → `feat(cli):` files list → `refactor(core):`
shared helpers → `feat(desktop):` UI.

1. **Exactly-once side-effect dispatch is a read fact, not an assumption.**
   `ingest_event` returns `duplicate:` before the side-effect block, so the
   emitter hook runs once per stored event — the hot path carries no
   idempotency query, exactly as v2 hoped ("verify during implementation").
2. **The "standard right-hand drawer" is a Sheet, not the members panel.**
   `MembersSidebar` turned out to be a centered modal `Dialog`, and the
   channel pane's true right-hand aux slot (thread/profile panels) is
   deeply coupled to split-pane resize state (`useSplitAuxiliaryPane`).
   v1 ships the drawer as a right-side `Sheet` (existing primitive, used
   by CommunitySwitcher) owned by `ChannelScreen` — zero `ChannelPane`
   surgery, members/files exclusivity moot (Sheet overlays). Graduating
   into the aux-panel slot is optional v1.1 polish.
3. **Backfill requires the live relay key.** NIP-09 deletions are only
   valid from the entry's author, so ephemeral-key backfill entries would
   be unretractable for interop clients. `--relay-key` /
   `BUZZ_RELAY_PRIVATE_KEY` is mandatory (unlike `reconcile-channels`).
4. **Backfill replays edits, including imeta-less ones.** The scan matches
   `tags @> [["imeta"]] OR kind = 40003` — an edit that removed every
   attachment carries no imeta but must still retract. Replay is
   oldest-first with the live reconcile semantics; backfill-mode
   retraction soft-deletes directly with no kind-5 (nothing subscribes
   pre-rollout).
5. **Retraction lookup is a dedicated JSONB containment query.**
   `EventQuery` has no `#e` filter, and the tempting `d_tag` pushdown is
   NIP-33-gated (`extract_d_tag` returns `None` for non-parameterized
   kinds — a `d` tag on a 1063 would never populate the column). Hence
   `get_events_by_kind_and_e_tag` (`tags @> [["e", id]]`, kind-bounded,
   unindexed — retraction is rare).
6. **Desktop routes are manifest-declared.** TanStack router runs with
   `virtualRouteConfig` (`src/app/routes.ts`) — a new route needs a
   manifest entry, not just a route file, before `routeTree.gen.ts`
   regenerates.
7. **The AppShell file-size ratchet tripped (+2 lines over 1000)** —
   resolved per the split-don't-bump rule by extracting
   `LazySettingsScreen` into its own module.
8. **Shipped as one branch, not two.** The v2 two-PR sequencing collapsed:
   data plane and UI landed as sequential commits on
   `feat/file-index-nip94`; they can still be split for upstream review if
   preferred.
9. **E2E asserts the privacy boundary structurally.** The community
   screen's accordion body (and its channel-scoped query) does not exist
   in the DOM before expand — `files-explorer.spec.ts` pins that, plus
   live append and kind-5 retraction in the drawer.

## Design revisions from v1

- `created_at` inheritance → **emission time + `shared_at` tag** (replica
  fence, migration 0021).
- `expiration`-tag propagation → dropped; TTL safety via **shadowing +
  backfill skipping TTL channels** (migration 0022 refreshes deadlines on
  every channel-scoped insert — per-event expiration was the wrong model).
- `p` uploader tag → **custom `uploader` tag** (push matcher / mention
  semantics, migration 0023).
- Edit diffing → **emit-all + retract-missing** via the idempotency key.
- Community view respecified as membership-batched; unscoped query banned.
- Backfill: fan-out removed; ordered-before-enable; TTL channels skipped.
- Net effect: **zero migrations, zero trigger edits, zero kind.rs changes.**

## Weighed and rejected

- **Client-published 1063s** — drift, third-party blind spots, three
  lifecycle implementations (v1 discussion).
- **Plain Postgres table + HTTP endpoint** — avoids trigger interactions
  but forfeits realtime fan-out, NIP-29 scoping, third-party readability,
  and contradicts the repo's events-first doctrine; would add the HTTP
  surface the project explicitly avoids.
- **`channel_id = NULL` storage to dodge triggers** — would exempt the rows
  from fence/TTL/push triggers but breaks `#h` query scoping, channel-expiry
  cascade, and visibility enforcement. Dodging triggers by leaving the
  channel domain is the wrong trade.
