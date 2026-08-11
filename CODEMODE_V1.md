# Codemode v1 — code-mode-by-default for flue agents

> **Fork-local implementation doc (deploy branch only — never upstream).**
> Status: **draft v2, 2026-08-11** — supersedes the same-day v1 draft;
> rewritten against the platform as it actually stands (M0–M5 sandbox
> ladder live, M2 workspace pilot decided, NIP-PC credential plane and
> durable delivery merged to deploy 2026-08-11).
> Design lineage: Cloudflare Code Mode (tool-passing mechanism),
> `@cloudflare/computer` (execution ladder + authoritative-workspace
> invariant, 2026-08-03), [AGENTOS_HOST_PLAN.md](AGENTOS_HOST_PLAN.md)
> (T2 topology), [AGENT_OS_M0.md](AGENT_OS_M0.md) (tier invariants),
> [docs/bench-m2/COMPARISON.md](docs/bench-m2/COMPARISON.md) (workspace
> substrate). agentOS spike results (2026-08-10) in session memory
> `rivet-agentos-compute-substrate`.

## Summary

Replace the model's chatty tool surface (bash, grep, glob) with **one
`code` tool**: the model writes plain JavaScript against a typed,
documented API (`sh`, `grep`, `glob`, `buzz.*`), the code executes
**inside the session's existing sandbox tier**, and only what the model
prints returns to its context. File editing stays on the classic
`read`/`write`/`edit` tools.

Why: models compose code more reliably than they chain tool calls; one
tool schema beats six; intermediate data (search results, loop state)
stays in the sandbox instead of round-tripping through the context
window. Buzz is unusually well-suited: every `buzz` CLI read returns
sig-stripped JSON arrays, tailor-made for in-code filtering.

```
model ──► code {code, timeout_ms} ──► JsExecutor (tier-declared)
                                        ├─ local/srt/docker (CM1): node runs
                                        │    .buzz-codemode/calls/<id>.mjs via
                                        │    sandbox.exec — same audit, caps,
                                        │    egress as bash today
                                        └─ agentos (CM2): vm.javascript.execute
                                             buzz.* = host-side binding
                                             guest network fully denied
workspace (CM2+): SeaweedFS filer ─ weed-FUSE ─┬─ host/native rungs   ✓ benched
                                               ├─ container bind-mount ✓ benched
                                               └─ agentOS host-dir     ⏳ CM2 spike
```

The model-facing contract (tool list, briefing, wrapper semantics) is
**identical on every tier** — M0 invariant 1. Tiers differ only in
executor.

## Platform state this plan builds on (as of 2026-08-11)

Three tracks landed in the last 72h; codemode is track 4 and composes
them rather than rebuilding anything:

1. **Sandbox ladder (M0–M5, live on gradient):** tier registry + per-exec
   audit; srt light tier live on canary + Fluelo (egress allowlists in
   prod); Docker heavy tier + `escalation = true` fleet binding live on
   canary; gVisor pre-staged; **M5 signing broker live on canary —
   sandboxes hold `BUZZ_SIGNER_SOCKET`, never the nsec.**
2. **Workspace substrate (M2 pilot, decided):** **SeaweedFS** beat
   JuiceFS-on-MinIO (~1.8× 4k IOPS, **~100× cross-mount
   delete-coherence** — the dimension that exists precisely for projected
   workspaces — 1 vs 4 pjdfstest failing files, no MinIO/Redis dep); both
   git-correct; the **container-rung projection was already exercised**
   (bind-mount trial; requirements learned: run container as host UID,
   ship git in the image). weed 4.41 + fuse.conf `user_allow_other`
   staged on gradient. Nests still live on local disk — projection GA is
   the workspace track's milestone, not codemode's.
3. **Credential + durability planes (merged to deploy 9c6ead4a):**
   NIP-PC provider credentials (kinds 30990/30991 → flue-host
   `FileCredentialStore`, runbook in flue-host docs) — provider keys
   host-durable, never env-file-bound, never sandbox-visible; buzz-acp
   **durable delivery** (persisted watermarks + startup backfill) closes
   the P0 restart-loss gap from the flue infra assessment.

Scorecard against `@cloudflare/computer` (their DO-supervised
isolate/container ladder over one projected workspace):

| computer's component | ours | status |
|---|---|---|
| authoritative workspace store | SeaweedFS (M2 winner) | ✅ selected, staged |
| container-rung projection | weed-FUSE bind-mount | ✅ validated (M2 trial) |
| supervisor durability | buzz-acp watermarks + backfill | ✅ merged |
| credential concealment via bindings | M5 broker + NIP-PC store | ✅ live / merged |
| isolate-rung projection | agentOS host-dir backend over weed mount | ⏳ CM2 spike |
| code-as-the-tool prompt surface | the `code` tool + briefing | ⏳ CM1 (this plan) |

The composition claim: Code Mode's prompt surface + computer's execution
ladder and workspace invariant + SeaweedFS/agentOS as the self-hosted
substrate — a combination Cloudflare itself has not shipped.

## The exact model-facing tool surface

### Tool list

| Tool | Classic (today) | Codemode | Source |
|---|---|---|---|
| `bash` | ✅ | ❌ removed (subsumed by `sh()`) | flue built-in |
| `grep` | ✅ | ❌ removed (subsumed by `grep()`) | flue built-in |
| `glob` | ✅ | ❌ removed (subsumed by `glob()`) | flue built-in |
| `read` | ✅ | ✅ unchanged | flue built-in |
| `write` | ✅ | ✅ unchanged | flue built-in |
| `edit` | ✅ | ✅ unchanged | flue built-in |
| `code` | — | ✅ **new** | ours (`defineTool`, `harness: true`) |
| `finish` / `give_up` | ✅ | ✅ unchanged | flue framework (loop-ending) |
| `task` | per flue | per flue (unchanged) | flue framework (subagents) |
| `activate_skill` | only if skills mounted (none today) | same | flue framework |

Mechanism: the tier's `SandboxFactory` gains
`tools: (sandbox) => [createReadTool(sandbox), createWriteTool(sandbox),
createEditTool(sandbox)]` (the documented flue seam — supplying `tools()`
replaces the default six-tool set), and `code` mounts via `useTool()`
because per-tool factories return pi-agent-core `AgentTool`s while
`defineTool` returns a `ToolDefinition` — the two documented paths, no
runtime forking. Framework tools are untouched.

Why `bash` is removed rather than kept alongside `code` (the classic set
is pi's native surface, so keeping it would be the path of least
resistance): with both tools mounted, the model's trained habit wins and
composition never activates — that would be code mode *available*, not
code mode *by default*. The removal is the load-bearing choice; the cost
is one wrapped line (`await sh("just ci")`); the revert is one
`createBashTool(sandbox)` in the `tools()` array. If the CM1 canary shows
real friction on trivial commands, trial a hybrid variant against it
before conceding the default.

> CM1 verification: capture the complete live tool list in the codemode
> golden transcript — that transcript, not this table, is the pinned
> truth.

### The `code` tool, verbatim

- **name**: `code`
- **description**:

  > Execute JavaScript in your workspace sandbox. Top-level `await`
  > works. These globals are available (full signatures in your
  > instructions): `sh()`, `grep()`, `glob()`, `buzz.*`. Node builtins
  > are available via `import()`/`require` (`node:fs/promises`,
  > `node:path`, …). Use one code call to compose multi-step work —
  > search, filter, loop, then act — and print only what you need to see
  > next; stdout, stderr, and the exit code come back to you. Plain
  > JavaScript only: no TypeScript annotations, no imports for the
  > globals. For reading or editing file content, prefer the
  > `read`/`write`/`edit` tools.

- **input schema** (valibot in code; JSON shape):

  ```json
  {
    "code":       { "type": "string",  "required": true },
    "timeout_ms": { "type": "integer", "minimum": 1000, "maximum": 600000,
                    "default": 120000 }
  }
  ```

- **result** (what the model sees, serialized JSON — same shape as `bash`
  today): `{ "stdout": string, "stderr": string, "exitCode": number }`.
  Sandbox violations surface inside `stderr` as the existing pinned line
  (`[sandbox] egress blocked by policy: <target>`); the 64 MiB output cap
  appends its existing truncation marker and forces `exitCode: 1`.

### The briefing (`useInstruction`), embedding `codemode.d.ts`

Injected once per session after the persona system prompt (~1.5–2k
tokens; net ≈ +1k after subtracting the three removed tool schemas).
Prose header:

> ## Codemode API
> Inside the `code` tool these globals exist. The declarations below are
> documentation — write plain JavaScript, not TypeScript. Reads return
> plain JSON. Failures throw an `Error` whose message contains the
> CLI/relay message; uncaught errors surface on stderr with a stack.
> Print summaries, not raw dumps.

```ts
/** Run a shell command in the workspace (same env/cwd as your other tools). */
declare function sh(cmd: string, opts?: { cwd?: string; timeoutMs?: number }):
  Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** ripgrep over the workspace. [] when nothing matches. */
declare function grep(pattern: string, opts?: {
  path?: string; glob?: string; ignoreCase?: boolean; maxResults?: number;
}): Promise<Array<{ file: string; line: number; text: string }>>;

/** Glob file paths under the workspace. */
declare function glob(pattern: string, opts?: { cwd?: string }): Promise<string[]>;

/**
 * Buzz relay operations. Already authenticated; signing is handled for
 * you. Reads return sig-stripped JSON (fields beyond those listed pass
 * through).
 */
declare const buzz: {
  channels: {
    /** Channels visible to this agent. */
    list(): Promise<Channel[]>;
  };
  messages: {
    /** Full-text search. kinds defaults to [9,45001,45003] (relay requires kinds). */
    search(q: { query: string; kinds?: number[]; channel?: string; limit?: number }): Promise<Msg[]>;
    /** The full thread containing `event`. */
    thread(q: { channel: string; event: string }): Promise<Msg[]>;
    /** One event by id. */
    get(q: { channel: string; event: string }): Promise<Msg>;
    /** Post a message; `replyTo` threads it. */
    send(q: { channel: string; content: string; replyTo?: string }): Promise<{ event_id: string; accepted: boolean }>;
  };
  reactions: {
    add(q: { channel: string; event: string; emoji: string }): Promise<{ event_id: string; accepted: boolean }>;
  };
};
interface Channel { id: string; name: string }
interface Msg { id: string; channel: string; author: string; content: string; created_at: number; kind: number }
```

The `buzz.*` v1 surface is deliberately curated (the CLI's high-frequency
ops: `channels list`; `messages search|thread|get|send`; `reactions add`
— from `MessagesCmd`/`ChannelsCmd`/`ReactionsCmd` in
`crates/buzz-cli/src/lib.rs`). Everything else stays reachable via
`sh("buzz …")`. Exact flag mapping is verified against `buzz --help`
during CM1 and pinned by the drift test. Growing the surface = one row in
`buzz-surface.ts`.

### Wrapper (not model-visible; pinned because it defines semantics)

Model code is wrapped, never executed raw — this is what makes `await`
work identically on every tier (node ESM would allow bare TLA; agentos
0.2.15 is CJS-only; the IIFE normalizes both):

```js
// .buzz-codemode/calls/<toolCallId>.mjs        (node tiers; ESM)
import "../api-globals.mjs";
(async () => {
/* model code */
})().catch((e) => { console.error(e?.stack ?? String(e)); process.exit(1); });
```

agentos variant (CM2): same string with a
`require("/workspace/.buzz-codemode/api-globals.cjs")` prefix, passed to
`vm.javascript.execute`. Semantics guaranteed to the model: globals
present, `await` allowed, uncaught error ⇒ stack on stderr + exit 1.

## Architecture

**Execution routing — the `JsExecutor` seam.** `sandbox.exec` is the CM1
executor's transport, not the architecture. Each `SandboxTier` declares
how JavaScript runs via an optional `jsExecutor` capability; the `code`
tool resolves it from the tier and never guesses:

| What runs | local / srt / docker (CM1) | agentos (CM2) |
|---|---|---|
| model's `code` body | ONE `sandbox.exec("<node> calls/<id>.mjs")` → real node process (host child / seatbelt-wrapped / `docker exec`) | `vm.javascript.execute(wrapped)` → V8 node-compat runtime — **never `sandbox.exec`** |
| `sh()` inside code | `child_process`, nested inside the same boundary | guest bridge → kernel process table → WASM software (sh/coreutils/git/rg); no native binaries |
| `buzz.*` inside code | `execFile("buzz")` in-sandbox (native CLI; M5 broker socket) | kernel-virtual `agentos-buzz` → RPC to host → binding `execute()` (native, host network, ~1 ms) |
| `read`/`write`/`edit` | flue `Sandbox` fs → tier fs | flue `Sandbox` fs → kernel VFS |

We deliberately do NOT route agentos through `os.process.exec("node …")`
even though the virtual node is spawnable — `javascript.execute` is the
sanctioned API with structured results and truncation flags, validated in
the spikes at ~20 ms warm.

**CM1 executor (local/srt/docker — today's live tiers).** On the first
`code` call of a session, the tool stages
`.buzz-codemode/api-globals.mjs` at the nest root via
`harness.sandbox.writeFile` (parents auto-created; never inside
`REPOS/`). Each call writes `calls/<toolCallId>.mjs` and runs
`sandbox.exec("<node> <file>", { timeoutMs, signal: ctx.signal })`.
Because it is a plain tier exec, the entire existing enforcement chain
applies unchanged: per-exec audit log (M0.5),
`BUZZ_FLUE_MAX_EXEC_OUTPUT_BYTES` bounded capture, egress
proxy/allowlist, violation normalization.

`api-globals.mjs` implements: `sh` → `child_process` with the wrapper's
own sub-timeout; `grep` → `rg --json` (host rg via srt native; docker
image check; `grep -rn` parse fallback); `glob` → `node:fs` walk (no
dep); `buzz.*` → `execFile("buzz", argv)` + JSON parse. **Credentials
need zero codemode work:** the sandboxed CLI already signs via the M5
broker socket (live on canary — sandbox env carries `BUZZ_SIGNER_SOCKET`,
not the key), and provider keys resolve host-side (pi provider layer,
now fed by the NIP-PC `FileCredentialStore`). Nothing key-shaped is
reachable from model code on any tier.

Node resolution per tier: `local`/`srt` use `process.execPath` (the exact
node running flue-acp; srt's host allowlist already passes PATH but the
absolute path is authoritative); `docker` bind-mounts that same binary
read-only at `/usr/local/bin/node` — the identical pattern and glibc
argument as the `buzz` CLI mount in `heavy-base.Dockerfile`. No image
rebuild.

**CM2 executor (agentos tier).** New tier `agentos`, pin
`@rivet-dev/agentos@0.2.15` **exact** — 0.2.16-rc.2 wedges `create()` on
darwin (sidecar boot deadlock; spike-verified). VM handle maps onto
flue's `Sandbox` contract; `code` calls
`vm.javascript.execute(wrapped, { output: { capture: "all" } })` (~20 ms
warm, ~250 ms VM create after first boot); `buzz.*` becomes the
kernel-virtual `agentos-buzz` binding CLI whose `execute()` runs
**host-side** (~1 ms round trip; stdout envelope `{"ok":true,"result":…}`
unwrapped by `api-globals.cjs`; zod validation host-side —
`BindingInputSchemaViolation at $.query: …` on stderr, exit 1).
Spike-pinned quirks encoded as tests: **always pass a full `permissions`
object** (a partial one flips every unspecified domain to deny, including
the `node` spawn that code execution rides on); **network fully denied**
(0.2.15 ignores allow-rules under deny-default — and deny-all is the
stronger posture anyway: the binding is the only egress);
`createContext(string)` if stateful cells are ever wanted; protocol
errors THROW `SidecarRejectedError` (structured `detail.code`) vs
result-level `outcome:"failed"` — the tool handles both.

**Durability semantics (unchanged, stated for the record).** The `code`
tool is non-durable, exactly like `bash` today: a host restart mid-call
settles the call unknown-outcome. `BUZZ_FLUE_DB` stays `:memory:`
(buzz-acp never reattaches sessions). What DID change platform-side:
buzz-acp's persisted watermarks + startup backfill now redeliver the
*mention* after a restart, so the turn re-runs rather than vanishing —
codemode inherits that for free and must not weaken it (per-call staging
files are disposable; re-staging is idempotent).

**Config.** `BUZZ_FLUE_TOOLMODE` = `codemode` | `classic`, read at
session start next to `BUZZ_FLUE_SANDBOX`; unknown values fail loudly.
fleet.toml: per-agent **top-level** key `toolmode = "codemode"` (beside
`model`/`respond_to`; NOT in `[agents.sandbox]` — tool surface is agent
policy, tier-agnostic by invariant 2), rendered into the unit env by
provision-fleet. CM1 lands with default `classic` (dark); CM3 flips the
default constant.

## Workspace & escalation

**Escalation is an explicit in-VM capability, never an automatic trap.**
For agents with fleet `escalation = true`, the agentos VM gets the
external sandbox attached (`@rivet-dev/agentos-sandbox`, local
`docker()` provider — sandbox FS at `/mnt/sandbox`, process surface as an
explicit guest binding) and the code API grows a `native.sh()` global
plus one briefing line; ungranted agents never see the symbol.
`@cloudflare/computer` ships the same shape: per-call, **agent-driven
backend selection** guided by tool descriptions ("agents today are
surprisingly capable of selecting the right environment"; container
needed for <10% of calls). The distilled policy, theirs and ours:
**selection among granted rungs is the model's, per call; granting is
never automatic.** Failure-triggered auto-escalation stays rejected:
(1) security inversion — invoking a binary name must not let model code
(or an injection it read) summon the wider blast radius the heavy-tier
caps exist to bound; (2) attribution — audit and resource caps assume a
call runs in exactly one boundary; (3) split-brain FS/env semantics —
dissolved only once the shared-workspace invariant lands, standing until
then.

**The shared-workspace invariant is one spike from real.** M2 selected
and validated the authoritative store (SeaweedFS; numbers above) and
already exercised the container rung. The projection stack:

```
SeaweedFS filer (authoritative)
  └─ weed-FUSE mount on host        ✓ benched (git-safe, coherent ~10 ms)
       ├─ native/host rungs          ✓ (same mount)
       ├─ container rung             ✓ benched (bind-mount; host-UID + git-in-image)
       └─ agentOS isolate rung       ⏳ host-dir backend (`createHostDirBackend`/
                                        `mounts[]`) over the same weed mount —
                                        the one unvalidated link (CM2 spike)
```

Rejected path, for the record: pointing agentOS's `s3` plugin at weed's
S3 gateway shares *storage*, not a POSIX *namespace* (the VM chunks its
own format) — it is not workspace projection. And nothing anywhere
requires sync code of our own: **SeaweedFS is the sync; every rung
mounts.** Until the workspace track moves nests onto SeaweedFS (its own
milestone, not codemode's), `native.sh()` runs with explicit
`/mnt/sandbox` staging semantics and the briefing says so.

## Capability ladders (post-v1 direction)

Escalation generalizes: every heavy capability gets a ladder — a cheap
default rung plus operator-granted higher rungs, all surfaced as bindings
in the same code API, selection per call by the model among granted
rungs. `sh()` → `native.sh()` is the first instance.

**Browser ladder — first post-v1 candidate (CM5).** Cloudflare names the
browser as an execution surface but ships no API; we define our own
rungs:

| Rung | API | Runs where | Notes |
|---|---|---|---|
| 0 | `web.get(url)` | host-side binding (agentos) / in-sandbox fetch through egress proxy (node tiers) | fetch + readability extraction to markdown; page JS never executes; always on |
| 0.5 | `web.dom(url)` | in-VM (linkedom-class) | DOM + selectors WITHOUT script execution; static scraping |
| 1 | `web.browser.*` | dedicated Chromium container (CDP) | JS-heavy pages, screenshots, flows; operator-gated per agent |

Security posture — the asymmetry from the exec ladder is deliberate:
**browsing is the injection frontier, so the browser rung does NOT share
the workspace.** The Chromium container mounts no nest, carries no
`BUZZ_*` env, gets its own egress allowlist and resource caps, and
returns data only through the binding — downloads become explicit
artifacts the model must place with its own code. Page content never
touches the nest or the keys except through model-authored code the
transcript shows.

## Blast radius

**Upstream: zero.** Every changed file is under `flue-host/` (fork-only,
deploy-only). No crates, no desktop/mobile/web, no relay surface, no
event kinds, no migrations.

**Unchanged by construction:**
- `buzz-acp` (Rust) and the ACP dialect — `code` streams as an ordinary
  `tool_call` (pending → in_progress → completed/failed); `translate.ts`
  untouched; desktop transcript renders it like `bash` today.
- Sandbox tiers' security envelope — the executor is `sandbox.exec`, so
  audit, output caps, egress enforcement, and the pinned violation string
  apply to model code exactly as to bash. **Codemode adds zero
  capability: anything the code can do, `bash` can already do on that
  tier.** (CM2 is strictly tighter: no guest network at all.)
- Credentials — provider keys host-side (T2), nsec behind the M5 broker
  (live on canary); since deploy 9c6ead4a provider keys also arrive
  host-durable via the NIP-PC credential sink (kinds 30990/30991 →
  flue-host `FileCredentialStore`) — never env-file-bound, never
  sandbox-visible; codemode changes nothing on this plane. CM2 removes
  even the broker socket from the sandbox.
- Durable delivery (watermarks + backfill) — codemode inherits it;
  staging files are disposable and re-staging is idempotent.
- Fleet provisioning flow, invite claim, unit model — env additions only.

**Risk register:**

| Risk | Exposure | Mitigation |
|---|---|---|
| Model quality regression on small actions | worse turns | canary per-agent via env; `classic` escape hatch; golden + task battery gate the default flip |
| Model emits TS annotations despite briefing | 1 lost turn (syntax error) | tool description forbids; agentos tier tolerates natively; if canary shows it, add host-side esbuild type-strip before staging |
| `console.log` floods | heap/context | existing 64 MiB kill-cap + downstream result truncation; briefing mandates summaries |
| Parallel `code` calls race the workspace | same as parallel bash today | per-`toolCallId` call files; no shared runner state |
| Node missing in a sandbox | tool dead on that tier | conformance codemode stage fails loudly at tier bring-up, not mid-turn |
| agentos preview churn (CM2) | rework | exact 0.2.15 pin (rc.2 darwin-broken), engine-seam wrap, spike quirks encoded as tests |
| Parallel sessions move deploy under in-flight work | merge friction | CM1 files are all new or small additive diffs in flue-host; rebase before land; buzz-sync rerere absorbs repeats |
| Briefing token cost | ~+1k/session net | measured in CM1; buzz surface stays curated |

**Rollback:** per-agent `BUZZ_FLUE_TOOLMODE=classic` + unit restart (the
same rehearsed muscle as `BUZZ_FLUE_SANDBOX` rollbacks). Default flip
(CM3) is one constant; revert is one commit. No data, schema, or protocol
migration in any direction.

## File changes

**New (CM1):**

| File | Purpose | ~LOC |
|---|---|---|
| `flue-host/src/codemode/contract.ts` | input schema, defaults, staging paths, wrapper template | 80 |
| `flue-host/src/codemode/briefing.ts` | instruction text + `codemode.d.ts` string (rendered from buzz-surface) | 120 |
| `flue-host/src/codemode/buzz-surface.ts` | curated fn → CLI argv map — single source for briefing, api-globals, drift test | 60 |
| `flue-host/src/codemode/api-node.ts` | generates `api-globals.mjs` source for node tiers | 180 |
| `flue-host/src/codemode/tool.ts` | the `code` tool (`defineTool`, `harness: true`): resolve `JsExecutor`, stage-once, write call file, run, map result | 130 |
| `flue-host/src/codemode/toolset.ts` | `withCodemodeTools(factory)` → `{ ...factory, tools: read/write/edit }` | 40 |
| `flue-host/test/codemode.test.ts` | wrapper semantics, schema, staging, toolmode selection | 150 |
| `flue-host/test/golden-codemode.test.ts` | golden ACP transcript: one `code` call doing search→filter→send against a stub `buzz` fixture | 120 |
| `flue-host/test/conformance/` (stage) | per-tier: node present, runner runs, cap kill, violation line stable | 80 |
| `flue-host/test/codemode-drift.test.ts` | briefing/surface vs built `buzz --help` (live-gated like docker conformance) | 60 |

**Modified (CM1):**

| File | Change | ~LOC |
|---|---|---|
| `flue-host/src/engine/agent.ts` | toolmode switch: codemode → `useSandbox(withCodemodeTools(f))` + `useTool(codeTool)` + `useInstruction(briefing)` | +15 |
| `flue-host/src/sandbox/types.ts` | `SandboxTier.nodePath?: string` + `jsExecutor?` capability (the routing seam) | +15 |
| `flue-host/src/sandbox/local.ts`, `srt.ts` | `nodePath: process.execPath` | +2 ea |
| `flue-host/src/sandbox/docker.ts` | read-only node bind-mount + `nodePath: "/usr/local/bin/node"` | +15 |
| `flue-host/src/fleet/config.ts` + `fleet.toml.example` | per-agent top-level `toolmode` → env rendering | +18 |
| `flue-host/README.md` | env row + section | +20 |

Total CM1 ≈ **900 LOC** incl. tests; every file far under the 1000-line
cap. All new files; the six modified files take small additive diffs —
deliberately merge-friendly against a deploy branch that moves daily.

**CM2 adds:** `flue-host/src/sandbox/agentos.ts` (~250 — tier +
full-object permissions + network-deny posture + host-dir workspace
mount), `flue-host/src/codemode/api-agentos.ts` (~120 — zod bindings +
`api-globals.cjs`), `package.json` exact pin, conformance registration.
Same model-facing contract, byte-identical briefing.

## Milestones

- **CM0 — land this doc.** Commit target is `deploy`
  (`docs(fork): codemode v1 implementation plan (deploy-only)`). Note:
  the main checkout currently sits on `feat/ai-accounts-desktop`; commit
  from a deploy-checked-out worktree or after that branch's session
  yields the checkout.
- **CM1 — land dark (node tiers).** Everything in the file table;
  default `classic`. Gates: existing classic golden byte-stable; codemode
  golden green; conformance stage green on `local` + `srt` locally and
  `docker` on gradient; briefing token delta measured (target ≤ +1.2k).
  Canary: flip `buzz-acp-canary` by env edit + restart, drive the
  existing smoke tooling (`fleet-smoke.ts`, `live-smoke.ts`) plus the
  M-series task battery (file-ops + complex-interaction, 7/7 bar);
  second agent: Fluelo (srt) after canary soak.
- **CM2 — isolate rung.** Pre-gate spikes, in order: (a) **agentOS
  host-dir backend over a weed-FUSE mount** — coherence + git-safety
  through the double bridge (weed-FUSE → host-dir backend → VM); (b)
  `@rivet-dev/agentos-sandbox` `docker()` pairing for `native.sh()`.
  Then the `agentos` tier + bindings + executor. Gates: conformance
  parity including the pinned violation line; M3-style live smoke
  campaign on the canary. Escalation ships with CM2 only if spike (b) is
  clean; otherwise tier-pinning remains the escalation story.
- **CM3 — default flip.** After canary soak + battery, flip
  `DEFAULT_TOOLMODE` to `codemode`; `classic` stays selectable ≥ one
  release. Tag per convention (`deploy/YYYY-MM-DD`).
- **CM4 — workspace GA (owned by the workspace track, referenced here).**
  Nests move onto SeaweedFS; `native.sh()` upgrades from `/mnt/sandbox`
  staging semantics to the one-workspace invariant. Codemode does not
  block on it.
- **CM5 — browser ladder** (§ Capability ladders).

## Non-goals (v1)

Steering; stateful/persistent code contexts; `checkJs` advisory lint
(revisit only if the canary shows API-typo burn); Python; upstreaming any
of this.

**API discovery / progressive disclosure** — deliberately absent in v1
and named as a seam. The curated surface (~15 functions, ~1.5–2k tokens)
ships whole in the briefing — the same full-API-in-prompt posture
Cloudflare Code Mode ships today (their dynamic search/browse is stated
future work; the `search_agents_code` in their example is the gitmcp
server's own tool, not a meta-feature). The at-scale pattern is
Anthropic's code-execution-with-MCP design: tool modules discovered on
demand (filesystem exploration / a `search_tools` function; 150k→2k
tokens in their example). When our surface outgrows the briefing —
`session/new.mcpServers` becoming real, or `buzz.*` growing — flue
already ships the primitive: **skills** (one catalog line in the prompt,
full reference pulled via `activate_skill`). Extended API docs mount as a
skill; MCP-schema → d.ts codegen feeds the same briefing. No new
machinery.

## CM1 verification checklist

- [ ] Live tool list captured in the codemode golden
      (finish/give_up/task presence confirmed) — the transcript is the
      contract.
- [ ] `buzz.*` argv map verified against `buzz --help` (flags, exit
      codes, `--format` default) and pinned by the drift test.
- [ ] `buzz.*` verified under **broker mode** on the canary
      (`BUZZ_SIGNER_SOCKET`, no key in env) — the code path must sign
      exactly as interactive bash does today.
- [ ] `toolmode` renders end-to-end: fleet.toml → provision-fleet → unit
      env → session start (unknown value fails loudly).
- [ ] `code` timeout default aligned with flue's bash tool default.
- [ ] `grep()` backend present per tier (rg on srt native; docker image
      or parse-fallback) — conformance asserts.
- [ ] Briefing net token delta measured (target ≤ +1.2k).
- [ ] Parallel `code` calls in one turn exercised in the golden (flue
      runs tool batches concurrently).
- [ ] Smoke reuse: `fleet-smoke.ts` passes against a codemode canary
      unchanged (it must — the ACP surface is identical).
