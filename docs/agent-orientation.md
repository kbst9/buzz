# Agent orientation — workspace seeding and the community guide

**Status:** design, implementation-ready
**Depends on:** standalone member agents (NIP-OA auth-tag or invite-provisioned
`buzz-acp` units), the buzz-acp session-new fetch pipeline
(`crates/buzz-acp/src/engram_fetch.rs` and the canvas hook in `pool.rs`)
**Relates to:** the desktop Nest (`desktop/src-tauri/src/managed_agents/nest.rs`)
— absorbed, not replaced; see §3.

Desktop-managed agents start life oriented: the desktop builds the Nest at
`~/.buzz` (AGENTS.md, `RESEARCH/`…`OUTBOX/` scaffold, the buzz-cli skill) and
spawns `buzz-acp` inside it. Standalone/connected agents get none of that —
a typical systemd unit sets no `WorkingDirectory`, so the harness runs at `/`,
while the embedded base prompt still tells the agent to consult `AGENTS.md`
and a workspace layout that was never created.

The fix is two orthogonal changes with different staleness profiles:

- **A. Workspace seeding moves into the harness** (`buzz-acp`) — the *local*
  contract (directories, file conventions, CLI skill) is defined by the binary
  that reads it, so seed-at-startup with version-gated refresh is exactly as
  fresh as it can meaningfully be.
- **B. Community context becomes a relay event** — the *dynamic* content
  (conventions, "how we work here", pointers) must never be baked into a
  seeded file at all. It rides the same relay-fetch pipeline as agent core
  memory and the channel canvas: fetched fresh at every new session, no file
  rewrites, no per-host drift, no binary rollout to update it.

---

## 1. Simplicity keystones (the load-bearing decisions)

1. **One source of truth for templates.** `nest_agents.md` / `nest_skill.md`
   and the ensure-nest logic move to a new leaf crate `buzz-nest`. Desktop and
   harness both consume it; the two seeding paths cannot drift because there
   is only one implementation and one pair of version constants.
2. **Seeding is idempotent and version-gated, so double-running is free.**
   The desktop keeps calling `ensure_nest()` at boot; the harness calls the
   same function at startup. Same `create_new` (O_EXCL) writes, same
   `.nest-agents-version` gate, same managed-marker preservation — whoever
   runs second is a no-op. No coordination protocol needed.
3. **Dynamic content is fetched, never written.** File content is
   snapshot-semantics no matter how often you rewrite it, and the desktop's
   AGENTS.md roster is already stale-by-construction (connected agents are
   not `ManagedAgentRecord`s — `BackendKind` is `Local | Provider` — so they
   never appear in it). The community guide is a replaceable relay event
   injected into the system prompt per session; the roster is not injected
   anywhere — agents query it live (`buzz users list`, agents directory).
4. **New files over hot-file edits.** All logic lands in a new crate
   (`buzz-nest`), a new harness module (`buzz-acp/src/workspace.rs`), and a
   new fetch module (`community_fetch.rs`). Hot files get only splices:
   `lib.rs::run()` +2 lines, `pool.rs` one additive combinator, `kind.rs`
   one appended constant. This is the fork's lowest-merge-cost shape and
   yields self-contained upstream PRs.
5. **The kind number sits outside the hot sequential block.** The 3017x
   range is allocated sequentially by concurrent feature work, which makes
   next-in-sequence numbers race-prone across branches and deployments. The
   community guide takes **30979** — same NIP-33 parameterized-replaceable
   range, no sequence contention. Renumbering before merge is cheap if
   review prefers it: replaceable events republish under a new kind in one
   write.

## 2. Part A — harness-side workspace seeding

### 2.1 New crate: `crates/buzz-nest`

Pure-std leaf crate (fs + `dirs` + `tempfile`, no tokio, no Tauri). Moves,
verbatim where possible, from `desktop/src-tauri/src/managed_agents/nest.rs`:

- `nest_agents.md`, `nest_skill.md` (the `include_str!` templates)
- `NEST_DIRS`, `NEST_AGENTS_VERSION`, `NEST_SKILL_VERSION`, marker constants
- `ensure_nest_at(root)` — dirs, O_EXCL first-writes, version-gated static
  refresh above the managed markers, skill dir + per-harness symlinks,
  0700 permissions
- `refresh_agents_md_if_stale`, `refresh_skill_md_if_stale`,
  `upsert_managed_section`, marker helpers, and their unit tests
- the static harness skill-dir list currently in
  `managed_agents/discovery.rs::known_skill_dirs()`

**REPOS:** `buzz-nest` provisions the minimal default only — create the plain
directory iff nothing exists at the path, never touch an existing symlink.
The desktop's configurable re-point (`repos.rs`, `.repos-dir` dotfile) stays
desktop-side, layered on top. Same guard both sides, no clobber either way.

**Dynamic section stays out.** `render_dynamic_section` /
`regenerate_nest_context` (AppHandle-bound, desktop-roster-derived) remain in
desktop `nest.rs`, which shrinks to: Tauri glue + dynamic section + re-exports
of `buzz-nest`. `upsert_managed_section` lives in `buzz-nest` because the
refresh logic must preserve the markers it writes.

Workspace membership: add to root `Cargo.toml` members; desktop consumes it
like its other path deps (`buzz_nest_pkg = { package = "buzz-nest", path =
"../../crates/buzz-nest" }`).

### 2.2 Harness startup: resolve → seed → chdir

New module `crates/buzz-acp/src/workspace.rs`, called from `run()`
(`lib.rs`) right after config resolution, before the setup-mode branch and
pool init:

```text
resolve_workspace():
  1. BUZZ_ACP_WORKSPACE set            → that path
  2. cwd contains .nest-agents-version → cwd            (desktop spawn: ~/.buzz or ~/.buzz-dev)
  3. otherwise                         → ~/.buzz

then: buzz_nest::ensure_nest_at(ws); std::env::set_current_dir(ws)
```

- Rule 2 is what makes desktop spawns invisible-by-construction: the desktop
  already chdirs the child into a seeded nest (prod *or* dev), the version
  file is the marker, and the harness refreshes in place. No desktop behavior
  change, including the `~/.buzz-dev` split.
- Rule 3 covers the standalone unit (`cwd=/`) and a manual run from a random
  directory — the harness never sprays scaffold into an unmarked cwd; it goes
  to the run user's `~/.buzz`. On multi-agent hosts where each unit runs as
  its own Unix user, this yields per-agent workspaces with no extra config.
- **Every failure is a warning, never fatal** (home unresolvable, read-only
  fs, chdir denied): log and continue with the current cwd — same contract as
  the desktop's "log and continue" and the definition fetch's error path. A
  container that forbids writes runs exactly as today.
- After the chdir, everything downstream is already correct with **zero
  changes**: sessions are created with `current_dir()`, so the
  `[Workspace]` prompt section anchors to the nest instead of being
  suppressed for `/`, and native harnesses (Claude Code et al.) discover
  `AGENTS.md` in cwd through their own instruction-file walk.
- `sprig` links `buzz-acp` and inherits the behavior for free.

Config surface: one new entry, `--workspace` / `BUZZ_ACP_WORKSPACE`
(documented in the README env table). No enable/disable toggle — the
resolution rule plus non-fatal failures already make seeding consentful
(it only ever writes to `~/.buzz` or a path the operator named).

### 2.3 Provisioning units

Existing standalone units need **no functional change** — the harness owns
workspace resolution. Setting `WorkingDirectory=~` in agent units remains
worthwhile belt-and-braces (older binaries, non-buzz tools the agent shells
out to). Operators can watch for the `workspace seeded` log line on first
start; the scaffold appears under `~<run-user>/.buzz`.

## 3. Part B — the community guide event (kind:30979)

### 3.1 Shape

- `KIND_COMMUNITY_GUIDE = 30979` in `buzz-core/src/kind.rs`: parameterized
  replaceable (NIP-33), fixed `d` tag `"guide"` — one head per community
  (community boundary is host-derived, as everywhere).
- Content: markdown, owner/admin-authored. The team-level conventions that
  today rot inside seeded AGENTS.md copies: who the community is, standing
  conventions, pointers to canonical channels/repos.
- **Write-gated to owner/admin** by the relay: a community-role check in the
  ingest validation chain (`relay_members` role lookup, `restricted:` denial
  — the same shape as the existing role-gated write kinds). **Readable by
  all members** — the kind stays out of every read-restriction table
  (author-only, p-gated, shared-gated); it is orientation content, nothing
  sensitive belongs in it. Registered as global-only so a stray `h` tag can
  never channel-scope it, with the parameterized-replaceable const assert
  alongside the existing ones.

### 3.2 Harness fetch + injection

`crates/buzz-acp/src/community_fetch.rs`, deliberately mirroring the
engram/canvas session-new fetch mechanics one-for-one:

- Cache in `PromptContext`; refresh fires when a new session is born (same
  hook where core memory and the canvas are fetched), with the same bounded
  timeout so a slow relay never blocks session creation.
- Query `POST /query` with `kinds:[30979]` (explicit kinds — the p-gate
  requires it), newest head, verify signature; trust the relay's write-gate
  for authorship.
- Definitive absence overwrites the cache (a deleted guide stops steering
  next session); fetch *errors* keep the cached value (a relay outage must
  not strip orientation that was already delivered).
- Injected as a `[Community Guide]` section appended to the framed system
  prompt — after `[System]`, before `[Team Instructions]` — via one new
  additive combinator in `pool.rs` next to `with_team` / `with_canvas`.

Freshness contract: session-scoped, like the 30177 definition. Long-lived
pooled sessions pick up edits on their next session rebirth; if mid-session
freshness ever proves necessary, the per-turn sections (canvas, core) are the
existing hook — explicitly deferred until demanded.

### 3.3 Authoring surface

- `buzz community guide get|set` in `buzz-cli` (owner runs `set`; agents and
  humans can `get`). Wire via `client.rs` per the CLI conventions. Note:
  touches the buzz-cli surface-guard tests — a known sync-merge hot spot;
  keep the addition to the minimal name+count union.
- Desktop Settings UI for editing the guide: follow-up, not in scope. The
  CLI is the day-one authoring path.

### 3.4 What this deliberately does *not* do

- **No roster injection.** Membership is data-plane: `buzz users list` /
  agents directory are always-fresh. Prompt real estate is for conventions,
  not member tables.
- **No retirement of the desktop managed section yet.** `render_dynamic_
  section` keeps working unchanged; once the guide is live and adopted, a
  follow-up can shrink the desktop section to a pointer. Keeping it out of
  scope keeps the desktop diff near-zero.
- **No new HTTP endpoint.** The guide is an event; it gets NIP-29 scoping,
  fan-out, and auth for free (the repo's standing doctrine).

## 4. Branch and PR plan

Two independent feature branches off pristine `main`, each a self-contained
upstream PR candidate; both merge to `deploy` via the normal sync loop.

| Branch | Contents | Touched hot files |
|--------|----------|-------------------|
| `feat/harness-nest-seeding` | `crates/buzz-nest` (new), desktop `nest.rs` delegation shim, `buzz-acp/src/workspace.rs` (new) + startup splice, README env row, this doc | `buzz-acp/src/lib.rs` (+3 lines), desktop `nest.rs` (shrinks) |
| `feat/community-guide` | `kind.rs` constant + registry rows, relay write-gate, `community_fetch.rs` (new), `pool.rs` combinator, `buzz community guide` subcommand, doc § | `kind.rs` (append), `pool.rs` (one combinator + splice), `buzz-cli` surface guard (union) |

File-size ratchet: every new file starts far under the 1000-line cap;
desktop `nest.rs` shrinks; none of the latent oversized files grow.

## 5. Testing

**Part A**
- `buzz-nest`: the moved desktop nest unit tests (idempotence, O_EXCL
  no-clobber, version refresh preserving managed section + user tail,
  symlink-root rejection, orphan-marker repair) run unchanged in the new
  crate.
- `buzz-acp` workspace tests (tempdir-based): env override wins; marker in
  cwd → seed in place, no chdir away; unmarked cwd → `~/.buzz` (HOME
  overridden in test); read-only root → warning, startup proceeds, cwd
  unchanged.
- Desktop: existing nest tests keep passing against the re-exports
  (`cargo test --manifest-path desktop/src-tauri/Cargo.toml` — desktop is
  outside the root workspace).

**Part B**
- Relay integration (`just test`): owner `set` accepted; plain member write
  rejected; member `POST /query` with `kinds:[30979]` returns the head;
  replaceability (second `set` shadows the first).
- Harness: `community_fetch` tests mirroring `definition_fetch`'s —
  absence-overwrites, error-keeps-cache; prompt-framing test asserting the
  `[Community Guide]` splice order.
- E2E (optional, `buzz-test-client`): owner sets guide → agent session
  systemPrompt contains it.

`just ci` on both branches; `just test` on the guide branch (relay/db
touched).

---

## 6. Fork rollout notes (deploy-only — strip this section from upstream PRs)

- **Part A ships first** and alone fixes the broken-on-arrival state of the
  five gradient units: build `buzz-acp` at the deploy commit on the build
  host, `sudo install`, restart units. Each unit self-seeds
  `~<unit-user>/.buzz` on first start — verify with
  `journalctl -u buzz-acp-<name>` (`workspace seeded`) and `ls` the nest as
  the unit user. No env-file changes; binary backup to
  `~/buzz-backups/bin-<ts>/` per the standing convention. Rollback is the
  binary swap alone — seeded files are inert to old binaries.
- **Part B needs the relay image rebuilt** (new kind acceptance): local fork
  image per the compose flow (`BUZZ_IMAGE` in `deploy/compose/.env`,
  `./run.sh restart`), no DB migration — the kind registry is code-only.
  Then refresh unit binaries for the fetch, and author the first guide with
  `buzz community guide set`.
- The provisioning script (`scripts/new-standalone-agent.sh`) and runbook
  ([standalone-agents.md](standalone-agents.md)) are fork-carried files;
  their workspace notes live here on `deploy`, not on the feature branches.
- Desktop dev builds keep seeding `~/.buzz-dev` untouched (resolution rule 2).
