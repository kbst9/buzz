# Storage Config from the Desktop App (Restart-to-Apply)

Implementation plan for making the relay's S3/Blossom storage configuration
editable from the desktop app by community **owner/admin** roles, persisted
relay-side, and applied on the **next relay restart**. No hot-swap.

Status: **design — not yet implemented.**

---

## Summary of decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Apply semantics | Restart-to-apply | Storage clients (`MediaStorage`, `GitStore`) are constructed once at boot and consumed across ~15 relay files. Hot-swap would be invasive; restart keeps every consumer untouched. |
| Write path | New NIP-43-style admin command, kind `9034` | Mirrors 9030–9033: processed directly, mutates a DB table, **never stored as a Nostr event** — which is exactly how the S3 secret stays out of the event store, fan-out, and RE-queries. |
| Read path (status) | NIP-98-authed HTTP `GET /storage-config`, owner/admin only | Mirrors `authorize_moderation_read` (`api/bridge.rs`) used by `/moderation/*` — the existing pattern for role-gated, non-event reads consumed by the desktop settings UI. |
| Who can write | `admin` or `owner` (same bar as 9033 workspace profile) | Matches the product direction. Owner-only (the 9032 bar) is a defensible tightening; flip one match arm if desired. |
| Persistence | New table `storage_config_override`, keyed by community | Migration `0026`. Env vars remain the fallback; a present row overrides env at boot. |
| Tenancy scope | Deployment community only (v1) | Storage is **process-global** (one bucket per relay instance). On multi-tenant instances, accepting 9034 from a secondary tenant's admin would re-point every tenant's storage. V1 accepts 9034 only from the deployment community and returns a clear error otherwise. |
| Secret at rest | Plaintext column in Postgres, write-only | The relay DB is already the trust root (it holds all events, membership, invites). Column is never returned by any read surface. Optional hardening (NIP-44 self-encryption to the relay keypair) is noted but out of v1. |
| Recovery | `buzz-admin storage-config clear` + `BUZZ_STORAGE_CONFIG_IGNORE_DB=1` break-glass env | Operator can always get back to env-defined config without touching SQL by hand. |

## Current state (what this changes)

- All S3 settings are env vars read once in `Config::from_env()`
  (`crates/buzz-relay/src/config.rs:633`): `BUZZ_S3_ENDPOINT`,
  `BUZZ_S3_ACCESS_KEY`, `BUZZ_S3_SECRET_KEY`, `BUZZ_S3_BUCKET`,
  `BUZZ_S3_REGION`, plus `BUZZ_MEDIA_BASE_URL`.
- `MediaStorage::new(&config.media)` is constructed in `main.rs` (~line 432)
  after DB connect, then `GitStore::new(...)` is built **from the same values**
  in `AppState::new` (`state.rs:694`). Changing this config re-points media
  *and* git-on-object-storage, identity archives, feedback attachments, and
  the hourly storage sweep.
- Nothing else needs to change at runtime: because both clients are built from
  `config.media` at boot, a boot-time merge of a DB override is picked up by
  every consumer automatically.

## Architecture

```
Desktop settings card (owner/admin)
  │  publish kind:9034 over existing authed WS          [secret in TLS transit only]
  ▼
relay ingest → is_relay_admin_kind → handlers/relay_admin.rs
  │  role check (admin|owner, deployment community only)
  │  MediaConfig::validate() on candidate
  │  S3 probe: PUT+GET+DELETE _probe/<event-id> (10s timeout)
  │  upsert storage_config_override row      [event NOT stored, NOT fanned out]
  │  redacted audit entry
  ▼
OK true "saved; takes effect on relay restart"

── relay restart ──
main.rs: Config::from_env() → DB connect → load override row
  → overlay onto config.media → validate → MediaStorage/GitStore as today

Desktop status display
  ▼
GET /storage-config  (NIP-98 auth, owner/admin, mirrors /moderation/* authz)
  → { source, endpoint, bucket, region, access_key_masked,
      updated_by, updated_at, pending_restart }        [never the secret]
```

## Changes by component

### A. `migrations/0026_storage_config_override.sql`

```sql
CREATE TABLE storage_config_override (
    community      UUID PRIMARY KEY,       -- CommunityId, same derivation as relay_members scoping
    s3_endpoint    TEXT NOT NULL,
    s3_access_key  TEXT NOT NULL,
    s3_secret_key  TEXT NOT NULL,          -- write-only: no read surface ever returns this
    s3_bucket      TEXT NOT NULL,
    s3_region      TEXT NOT NULL,
    updated_by     CHAR(64) NOT NULL,      -- hex pubkey of the admin who set it
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Single row per community; v1 only ever reads/writes the deployment
community's row. `BUZZ_MEDIA_BASE_URL` is deliberately **not** included — it
changes what URLs clients see and is coupled to reverse-proxy/DNS setup;
keep it operator-only.

### B. `crates/buzz-core/src/kind.rs`

- `pub const RELAY_ADMIN_SET_STORAGE_CONFIG: u32 = 9034;` (doc comment: admin/owner-signed, deployment community only, processed-not-stored).
- Add to the kind registry list and to `is_relay_admin_kind()` (this is what
  routes it down the 9030-series "process directly, never store" path in
  `handlers/ingest.rs` — the exemptions at ingest.rs:1551/:1640/:1655/:1853
  come along for free).

Command shape (content JSON; fine to carry the secret because the event is
never persisted — tags would be equally transient but content models a struct
naturally):

```json
{ "action": "set",
  "endpoint": "https://s3.us-west-2.amazonaws.com",
  "access_key": "AKIA…", "secret_key": "…",
  "bucket": "buzz-prod-media", "region": "us-west-2" }
```

`{ "action": "clear" }` deletes the override row (revert to env on next
restart). Empty `access_key` **and** `secret_key` together are valid and mean
"use the AWS default credential chain" (existing `MediaStorage::new`
semantics — IAM role on the relay host).

### C. `crates/buzz-db` — new module `storage_config.rs`

`get(community) -> Option<StorageConfigOverride>`, `upsert(...)`,
`clear(community)`. Follow the existing per-table module pattern
(`relay_members.rs` is the closest sibling). No secret in `Debug` impls —
implement `Debug` manually or wrap the secret in a redacting newtype.

### D. `crates/buzz-relay`

1. **`handlers/relay_admin.rs`** — new match arm for 9034 (the dispatch
   `match kind` at ~line 258):
   - Role check: reuse the existing admin-or-owner lookup used by 9030/9033,
     including the `moderation_restriction_state` guard already applied at
     the top of the handler.
   - Tenancy: reject unless `tenant.community()` is the deployment community
     (clear error: `storage config is deployment-scoped`).
   - Parse + validate: build a candidate `MediaConfig` from the current
     effective config with the five fields overlaid; run
     `MediaConfig::validate()`. Enforce sane field caps (endpoint must be
     http(s) URL ≤ 2 KB; bucket/region/keys ≤ 256 chars).
   - **Probe before persist**: `MediaStorage::new(&candidate)` then
     PUT → GET → DELETE `_probe/<event-id>` (~16 bytes, `text/plain`) under a
     single 10 s `tokio::time::timeout`. Probe failure → OK `false` with the
     S3 error string; nothing persisted. This also validates network
     reachability *from the relay host*, the only place it matters (see
     "Locked-down storage" below).
   - Persist via `buzz_db::storage_config::upsert`, emit a **redacted** audit
     entry (endpoint, bucket, region, access key masked to last 4, actor
     pubkey — never the secret), return OK `true` with
     `"storage config saved; takes effect on relay restart"`.
2. **`main.rs` boot merge** — after DB connect, immediately before the
   existing `config.media.validate()` (~line 428):
   - Skip entirely if `BUZZ_STORAGE_CONFIG_IGNORE_DB=1` (break-glass).
   - Resolve the deployment community (same binding used for
     `config.relay_url`'s host; if unresolvable — fresh DB — skip, env wins).
   - If a row exists, overlay the five fields onto `config.media` and
     `tracing::info!` a redacted line
     (`storage config: DB override active (set by <pubkey> at <ts>)`).
   - **No boot-time probe** — today's semantics (S3 failures surface
     per-request, relay still boots) are preserved deliberately: creds
     revoked after a successful save must not brick relay startup.
3. **`GET /storage-config` status endpoint** (router.rs + a small handler
   module): auth exactly like `authorize_moderation_read`
   (`api/bridge.rs:2046` — Host→tenant binding, NIP-98 signature +
   replay guard, owner/admin authz). Response:

   ```json
   { "source": "override" | "env",
     "endpoint": "…", "bucket": "…", "region": "…",
     "access_key_masked": "…6411" | null,
     "updated_by": "<hex>" | null, "updated_at": "<iso>" | null,
     "pending_restart": true | false }
   ```

   `pending_restart` = stored row differs from the process's effective
   `config.media` (compare all five fields server-side; both are available
   in-process, so no fingerprint scheme needed). The secret never appears;
   the access key only masked.

### E. `crates/buzz-admin` — recovery subcommands

`storage-config show` (prints the row with secret redacted, plus whether it
differs from env) and `storage-config clear` (deletes the row). Direct-DB,
same connection pattern as the member commands. This is the lockout escape
hatch when a bad-but-probe-passing config (e.g. creds revoked later) has to
be reverted without a working UI.

### F. Desktop (`desktop/src/features/settings/`)

- **`StorageSettingsCard.tsx`** in `SettingsView` beside
  `ModerationQueueCard`. Visibility gate copies the existing pattern
  (`ModerationQueueCard.tsx:545`): `membershipQuery.data?.role` ∈
  {`owner`, `admin`}. Client gating is cosmetic; the relay enforces.
- Read: react-query against `GET /storage-config` (NIP-98 header via the
  existing bridge-auth signing helper the moderation queue uses). Renders
  source (env vs app-set), endpoint/bucket/region, masked key, updated-by,
  and a **"pending relay restart"** banner when applicable.
- Write: form with endpoint, access key, secret key (`type=password`,
  never pre-filled; v1 requires the full credential set on every save — no
  partial update semantics), bucket, region. "Test & save" publishes kind
  9034 over the existing authed relay socket (same publish path the app uses
  for other admin commands) and surfaces the OK message verbatim (probe
  errors are actionable: wrong region, 403, DNS).
- **Destructive-change confirm**: changing endpoint or bucket gets an
  explicit dialog: *"Existing media, git repositories, and archives stay in
  the old bucket and will 404 until migrated. Buzz does not migrate data."*
- "Revert to server config" button → 9034 `{"action":"clear"}`.
- E2E: mock-bridge handlers for the status endpoint + publish ack, one spec
  covering role-gated visibility, save flow, pending-restart banner
  (`desktop/tests/e2e/`, `pnpm build:e2e` rules apply).

### G. Docs / config surface

- `.env.example`: document the full `BUZZ_S3_*` block (currently absent —
  the config surface is undiscoverable), plus precedence:
  *DB override (if set, wins) → env → defaults*, and
  `BUZZ_STORAGE_CONFIG_IGNORE_DB`.
- This file is the design record; add a pointer from `ARCHITECTURE.md`'s
  storage section.

## Secret-handling invariants (each gets a test)

1. Kind 9034 is **never written to the events table** (assert via integration
   test: publish, then query events by kind/author → empty).
2. Never fanned out: no Redis publish, no live subscription delivery.
3. Audit entries, `tracing` output, `buzz-admin show`, and
   `GET /storage-config` never contain `s3_secret_key` (grep-style
   assertions on captured output/responses).
4. No `Debug`/`Display` derivation ever prints the secret (redacting newtype).
5. Desktop never receives the secret back (status endpoint contract test) and
   never pre-fills the secret field.
6. In transit the secret rides the NIP-42-authed WSS connection only — same
   TLS envelope as any password form.

## Locked-down storage and locally-executing agents (FAQ)

**S3-level auth is a non-issue by design.** Clients — desktop, mobile, CLI,
and agents — never contact S3. Every media URL Buzz hands out is
`https://<relay>/media/<sha256>.<ext>` (`public_base_url` must end in
`/media`), and the relay streams the object from S3 server-side using its own
credentials. A fully locked-down bucket (private ACLs, VPC-only endpoint, IP
allowlist) works as long as **the relay host** can reach it — and the
write-path probe validates exactly that, from exactly that host. Agents need
zero S3 awareness, credentials, or network reachability.

**The gate that does exist is relay-side**: `BUZZ_REQUIRE_MEDIA_GET_AUTH`
(alias `BUZZ_REQUIRE_MEDIA_READ_AUTH`; default **off**). When enabled,
`GET/HEAD /media/*` requires a signed Blossom kind:24242 `t=get` auth event
plus relay membership. Locally-executing agents can satisfy it: the ACP
harness injects `BUZZ_PRIVATE_KEY`, agents are relay members, and `buzz-cli`
already signs media GETs (`sign_blossom_get`,
`crates/buzz-cli/src/client.rs:325`). The residual gap is agents fetching
media URLs with raw `curl`/HTTP libraries instead of the CLI — those get
401/403 while the gate is on, which is why `.env.example` says to keep it off
until all deployed clients attach read auth. None of this changes with the
DB-override work; it's orthogonal.

## Testing plan

- **Unit** (`buzz-relay`, `buzz-media`, `buzz-db`): overlay/precedence logic,
  field caps, `validate()` on candidates, redacting newtype, masked-key
  formatting, pending-restart diff.
- **Integration** (`just test`): role matrix (member → rejected, admin/owner →
  accepted, restricted admin → rejected, secondary tenant → rejected);
  probe-failure → no row persisted; upsert/clear round-trip; boot merge
  applies row; `IGNORE_DB` skips it; secret invariants 1–3 above; status
  endpoint auth matrix (no auth → 401, member → 403, admin → 200) + replay
  rejection.
- **Desktop**: component tests for gating/masking/banner; E2E spec per §F.
- **Manual smoke** (staging): save → restart relay → upload + git push land
  in the new bucket; old-bucket URLs 404 as warned; `clear` + restart reverts.

## Sequencing and blast radius

Land as one upstream-PR-candidate feature branch off `main`
(`feat/storage-config-desktop-admin`); every step is additive.

| # | Change | Files | Merge-conflict surface |
|---|--------|-------|------------------------|
| 1 | Migration + buzz-db module | 2 new | None (new files; migration number `0026` may need renumbering at merge time) |
| 2 | Kind 9034 + registry | `kind.rs` | Low — append-only constants; registry list is a known trivial-conflict site |
| 3 | Relay handler + boot merge + status endpoint | `relay_admin.rs`, `main.rs` (~10 lines), `router.rs` (1 route), 1 new module | Medium — `relay_admin.rs` and `router.rs` are shared surfaces; keep the 9034 arm self-contained |
| 4 | buzz-admin subcommands | `main.rs` (buzz-admin) | Low |
| 5 | Desktop card + hooks + E2E | ~4 new files, `SettingsView.tsx` (1 insertion) | Low — mirrors ModerationQueueCard placement |
| 6 | `.env.example` + docs | 2 | None |

Deliberately untouched: `buzz-cli` (no new subcommand in v1 → the surface-guard
tests in `crates/buzz-cli/src/lib.rs`, a known fork-sync hot spot, never
conflict), all 15 `media_storage`/`git_store` consumer files, and the mobile
app (settings card is desktop-first; mobile reads nothing new).

## Out of scope (v1)

- **Hot-apply / self-restart** — the relay never restarts itself; the UI says
  "takes effect when the relay restarts" and the status endpoint reports
  `pending_restart` indefinitely until the operator restarts.
- **Data migration between buckets** — explicitly warned in the UI, never
  performed.
- **Per-tenant storage backends** — storage stays process-global; secondary
  tenants cannot see or set it.
- **`BUZZ_MEDIA_BASE_URL` / size limits in the UI** — coupled to
  reverse-proxy topology and abuse controls; operator-only.
- **Secret encryption at rest** (NIP-44 to the relay keypair) — possible
  hardening once v1 settles; the schema doesn't preclude it.
