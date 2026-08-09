# agentOS Readiness Analysis — Phase-2 Sandbox Tier

> **Fork-local analysis doc (deploy branch only — never upstream).**
> Date: **2026-08-08**. Companion to [AGENTOS_HOST_PLAN.md](AGENTOS_HOST_PLAN.md)
> (v2) — this is the readiness re-check for its **Phase 2 (sandbox hardening
> tier)**, against agentOS **v0.2.15** (stable, 2026-07-28) and
> **v0.2.16-rc.2** (2026-08-07). agentOS is preview software and moves fast;
> re-verify against current docs before acting on specifics.

## Verdict

**Materially ready for Phase 2.** Three of the four frictions from the July
2026 evaluation have resolved; the one that remains (native binaries) has two
viable, bounded resolutions and one of them *improves* our credential posture
over today's T2-local. The official Flue glue is unusable for us as shipped
(it targets Rivet's Flue fork), but the correct integration was always going
to be our own adapter, and it is small.

## What agentOS actually is (corrected mental model)

Not a bare V8 isolate, and not a Linux sandbox — a **virtual OS as a
library**:

- A shared **sidecar process owns a real kernel per VM**: virtual filesystem,
  process table, pipes, PTYs, and a virtual network stack. Every guest
  syscall is brokered; nothing the guest does touches host FS/sockets/processes.
- **Guest JavaScript runs on full-JIT V8** (per-VM isolate); **CLI tools run
  as WASM**. Node.js and Python execution are runtime-level capabilities
  (since v0.2.15).
- **Real process model**: one-shot `exec`, background `spawn` with streaming
  stdio + stdin, interactive PTY shells, subprocess trees, in-VM servers.
- **Permissions**: filesystem/network/process/env gated; outward-facing
  capabilities (egress) **denied by default**.
- Cost shape: warm VM in single-digit ms, tens of MB per VM; many VMs share
  one sidecar.

What it deliberately is **not**: a Linux syscall surface. No native ELF
binaries, no display server, no docker-in-VM. Their own framing: "agentOS
covers most use cases; a sandbox adds a full Linux environment for special
software."

## What moved since the July evaluation

1. **Actor runtime is now optional.** `@rivet-dev/agentos-core` standalone:
   `AgentOs.create()` boots a VM in-process and returns a direct handle
   (exec/spawn/PTY + fs + mounts). No rivetkit, no Rivet Actors. This answers
   the plan's Phase-2 spike question about rivetkit/actor requirements.
2. **S3 mounts are the exact metadata-split design we wanted.** Built-in `s3`
   mount plugin is a **chunked block store** (4 MB chunks as S3 objects +
   separate metadata layer — *not* git-unsafe 1:1 object mapping), with
   custom `endpoint` (MinIO works) and per-agent `prefix`. "Agent = keypair +
   auth tag + S3 prefix" is realizable without us building the JuiceFS layer.
3. **Custom WASM software is first-class.** Registry + package definition
   format + compile-from-source toolchain — the sanctioned path for our own
   in-VM commands.
4. **Flue integration exists officially** (validates the pattern) — but see
   the fork caveat below.

## Escalation to external sandboxes (corrected)

The pairing exists (`@rivet-dev/agentos-sandbox` + `sandbox-agent`) but
escalation is **explicit and configured, never an automatic trap** — a native
binary invoked in the VM shell simply fails; nothing transparently forwards
it. Mechanics:

- **Filesystem mount**: the external sandbox's FS appears in the VM at
  `/mnt/sandbox` (configurable via `mountPath`/`sandboxRoot`/`readOnly`);
  the agent reads/writes it through normal `fs`.
- **Bindings**: the sandbox's process management is exposed as an in-VM CLI
  (`agentos-sandbox run-command --command "…" --cwd "…"`) called through the
  same exec/spawn surface as any command. The agent (or harness tool policy)
  must deliberately route work there.
- **Provider-agnostic** via Sandbox Agent (sandboxagent.dev): cloud (E2B,
  Daytona — billed per second) or **local `docker()`** — first-class, and the
  one that matters for our self-hosted posture: the heavy tier is a Docker
  container on gradient, no new vendor.
- Sandboxes start lazily on first use and are disposed with the VM. One
  session can mix lightweight VM work with heavy sandbox work.

Their named sandbox-tier cases: native binaries, browsers/desktop automation
(Playwright/Puppeteer), heavy/native compilation, GUI apps, npm packages with
native extensions (`sharp`, `bcrypt`, `better-sqlite3`).

## Toolbox inventory (registry `@agentos-software/*`, 2026-08-08)

**Present**: coreutils, sed, grep, gawk, findutils, diffutils, tar, gzip
(defaults) + **ripgrep, jq, tree, git** + agent CLIs (claude-code, codex,
codex-cli, opencode, pi, pi-cli). Node + Python via the runtime.

**Missing (useful, roughly by how often real agent work wants them)**:

| Gap | Notes |
|---|---|
| Browser / headless Chrome | Their #1 sandbox-tier case; Docker tier for us |
| curl / wget | No shell HTTP client; workaround = in-VM Node `fetch`. Softened for us by default-deny egress (relay-only posture) |
| unzip / xz / zstd | Only tar+gzip today |
| ssh | Sandbox tier |
| gh | Go-native; relevant to our repo-touching agents |
| make + native toolchains (cargo/gcc/go) | Sandbox tier by design |
| ffmpeg / imagemagick / sqlite3 CLI | Absent |
| **`buzz` CLI + `git-credential-nostr`** | **Ours.** Native Rust; see below. In-VM `git` exists but relay-git push needs the credential helper, so one decision covers both |

## The Flue-fork caveat (do not adopt)

The official glue (`@rivet-dev/agentos-flue`, `agentOSSandbox()`) requires
**Rivet's fork of Flue** — `@flue/runtime` aliased to
`@rivet-dev/labs-flue-runtime@1.0.0-beta.9-rivet.2` (an old 1.x line) plus
rivetkit actors. We run upstream `@flue/runtime` 2.0.1 (2.0.3 current).
Upstream merge of the fork's extension APIs is "in progress" per their docs.

**Our path instead**: upstream Flue 2.0.x's sandbox contract
(`SandboxFactory` → `SessionEnv`: `bash()` + ~10 fs methods + `cwd`; see
`types-*.d.mts` in `@flue/runtime`) is a designed extension point and maps
~1:1 onto the agentos-core VM handle. Our entire integration surface today is
one line — `useSandbox(local({ cwd, env }))` in
[`flue-host/src/engine/agent.ts`](flue-host/src/engine/agent.ts). Phase 2 =
write our own `agentOsSandbox()` factory over `@rivet-dev/agentos-core`
(a few hundred lines, golden-testable like the local path), swap that line.
Consistent with plan decision 3: the adapter seam is ours.

## Phase-2 shape for flue-host

1. **`agentOsSandbox()` factory** over agentos-core: `exec`/fs mapped to the
   `SessionEnv` contract; VM per ACP session; pinned exact version; behind
   the `engine/` seam with the golden transcript as the canary.
2. **Workspace**: nest on an `s3` mount against our MinIO
   (endpoint + credentials + per-agent prefix), cwd from provisioning —
   neither buzz-acp nor flue-acp changes (plan decision 4 lands here).
3. **`buzz` CLI (+ `git-credential-nostr`) — two options**:
   - *Host-bridge stub* (preferred first): guest-side `buzz` command proxies
     to the host process where the native CLI runs. **`BUZZ_PRIVATE_KEY`
     never enters the sandbox** — Ring 2 shrinks from "agent key in sandbox
     env" to a bridge socket. Security upgrade over today's T2-local.
   - *WASI build* as custom registry software: officially supported path;
     feasibility of the CLI's WS/HTTP stack through the VM's virtual network
     is unspiked.
4. **Egress**: default-deny + relay-only allow. In T2 no model traffic exists
   inside the sandbox, so this costs nothing.
5. **Heavy tier**: `sandbox-agent` with local `docker()` on gradient, exposed
   as the standard binding; harness policy (not autodetection) decides what
   runs there (cargo builds; browsers if ever).

## Industry validation & the actor question (added 2026-08-08)

Nathan Flurry (agentOS creator) published "Run Your Harness Outside of the
Sandbox (Why and How)" (x.com/NathanFlurry/status/2081768022025658672,
2026-08): the industry — OpenAI Agents SDK, Anthropic Managed Agents,
Vercel Eve, Cloudflare Flue, Amp Orbs — has converged on **harness outside
the sandbox, sandbox exposed as tools**. That is topology T2 verbatim; his
three "why" reasons map point-for-point onto what Buzz already does:

| Article's reason | Where Buzz already does it |
|---|---|
| Blast radius: loop/retries/history must survive sandbox death | buzz-acp + systemd own the loop; the conversation IS relay events; observer transcript archives owner-side |
| Trust boundary: LLM creds, permissions, audit, agent-to-agent outside | Ring 1 host-side; `respond_to` gating in buzz-acp; relay events + hash-chain audit; agent↔agent routes through the relay |
| Sleeping sandbox: something outside must schedule/wake/index | buzz-acp holds the WS; scale-to-zero = Phase-5 push leases; sessions indexable relay-side |

Two clarifications the article sharpens:

1. **agentOS wears two hats.** For mainstream harnesses (Claude Code, Codex,
   OpenCode) that cannot run split natively, agentOS's VM *hosts the harness*
   with the external sandbox mounted under it — their compatibility story.
   That is NOT our path: Flue is a programmable harness with a native sandbox
   seam (his own FAQ: Pi — which Flue forks — "supports it directly"), and
   putting Flue inside a VM would force model credentials into a trust
   boundary, breaking T2's core property. Flue stays on the host, outside
   both sandbox tiers; agentOS is the light exec tier only.
2. **Rivet Actors are not an alternative to agentOS — they're an alternative
   to buzz-acp, and we keep buzz-acp** (plan decision 2). The actor pitch —
   durable loop, state-next-to-loop, sleep/wake, wake-on-request,
   multiplayer — is exactly the job buzz-acp + systemd + the relay already
   do (one "actor" per agent = one unit; the relay is the state and
   multiplayer layer). Adopting rivetkit would mean porting NIP-42 auth,
   gating, queueing, and the observer lane to TS actors for sleep/wake
   economics we don't need at current scale (idle unit ≈ one small Rust
   process + one WS), and wake-on-mention requires relay push leases
   (Phase 5) with or without actors. Revisit only at hundreds-of-agents
   scale; `agentos-core` without actors is an officially supported mode.

Side-note: Flurry's survey calls Flue "Cloudflare's" — **that's wrong**
(corrected 2026-08-09 by the ecosystem scan below): Flue is
**withastro/flue** (Astro org, Apache-2.0, 7.8k★, very active). It *ships*
a Cloudflare deploy target and a `cloudflareSandbox()` adapter, which
explains the mislabel. The "T2, Cloudflare-computer shape" comparison in
the plan stands on architecture, not ownership.

## Resolved after first cut (same day, from bindings/persistence docs)

- **Bridge mechanism is fully specified by custom bindings**: host JS
  functions (Zod schemas) auto-become CLI shims at
  `/usr/local/bin/agentos-{name}` in the VM, are auto-injected into the
  system prompt, return a JSON envelope, support per-binding timeouts. The
  `buzz` bridge = a bindings group shelling out to the native CLI in the
  flue-acp process (auth env lives there; **nsec never enters the VM**).
  Cosmetic wrinkle only: shims are named `agentos-…`; a two-line guest
  wrapper script presents plain `buzz` in `PATH`. WASI buzz-cli becomes the
  fallback, not the plan.
- **Core-standalone persistence**: VM creation supplies one SQLite
  descriptor (sidecar writes FS chunks/session state through it, not through
  JS). In core mode that's a SQLite file we manage; mostly moot for the
  workspace, which rides the S3 mount. Verify root-FS semantics in the spike.

## Remaining unknowns (sharpened 2026-08-08)

### Escalation mechanics
- **The egress hole — most important open item.** The VM is default-deny,
  but the escalated Docker container gets whatever network Docker gives it:
  unless the `docker()` provider exposes network config
  (`--network none`/internal + allowlist), escalation is a one-command
  escape from the egress policy. Pin down before enabling the tier at all.
- **Filesystem disjointness.** Sandbox FS mounts into the VM at
  `/mnt/sandbox`; nothing projects the VM's S3 workspace into the sandbox.
  Workable pattern: copy through the mount, build, copy artifacts back —
  agent-visible ceremony, slow for big trees, sandbox is ephemeral (disposed
  with the VM). Needs a convention + prompt guidance + perf check.
  **Better pattern, stolen from cloudflare/computer** (MIT, preview — the
  matured "variant C"; its container backend FUSE-projects the
  authoritative Durable-Object workspace INTO the sandbox via `computerd`):
  make the workspace authoritative outside and project it in. For us: a
  host-side JuiceFS-class mount of the agent's S3 prefix (same MinIO, same
  prefix as the VM's `s3` mount) bind-mounted into the Docker container —
  one source of truth, no copy ceremony, artifacts land in the workspace
  automatically. Computer itself stays unusable as a tier (DO + Dynamic
  Workers + CF Containers at every joint — platform-bound, and
  "NOT suitable for production" by its own README), but it is the best
  reference implementation of the T2 workspace-projection pattern.
- **Failure UX.** What a native binary invocation actually errors with
  in-VM determines whether the model self-corrects to the sandbox binding.
  Mitigate via the binding description (auto-injected into the prompt).
- **Escalation is a capability**: any prompt-injected turn can call a
  registered binding — register the sandbox binding per-agent (fleet.toml
  flag), never fleet-wide default.
- Lifecycle hygiene: container leaks on flue-acp crash; churn per session at
  fleet scale. Observe empirically.

### Which sandbox
- **Decided by posture: local `docker()` on gradient** (cloud providers are
  per-second billed and not self-hostable — out). Unverified specifics in
  `sandbox-agent` (separate product, v0.4.2, preview — pin exact): base
  image selection (we want a custom pinned image: cargo/rustc, node/pnpm,
  just, git), CPU/mem limits, rootless support, container naming/cleanup,
  cold-start latency, and the network knobs above. One afternoon on gradient.
- Phase-6 note: plain Docker is fine for our own agents; hosting strangers
  wants gVisor/Kata underneath. Not now.

### Tooling to add
- `buzz` bridge: build it (mechanism resolved above).
- `git-credential-nostr`: small open seam — git's credential-helper protocol
  is a stdin/stdout exchange, bindings are flag/JSON-shaped. Guest wrapper
  speaking the helper protocol → binding call, or bridge-side token
  pre-fetch. Small spike.
- **Web fetch — product decision (Kevin).** Fluelo fetches the web today
  (local sandbox had host network); default-deny VM egress breaks that.
  Options: per-agent VM egress allowlist, or (recommended) a host-side
  `agentos-fetch` binding — keeps default-deny, centralizes per-agent
  policy + audit.
- Registry adds: unzip/xz as custom WASM (cheap). Skip curl (fetch binding
  covers it), gh, ffmpeg for now.

### Cross-cutting
- **macOS sidecar support unknown** — docs name only server platforms
  (Node/Bun/Deno on Railway/K8s/Vercel). If Linux-only, dev + golden tests
  run on gradient/CI, which changes DX. Check in the first spike hour.
- S3-mount git behavior under our MinIO (block store should be git-safe;
  verify clone/commit/push + crash-consistency empirically).
- VM-per-ACP-session vs per-agent: start per-session (matches
  Flue-instance-per-session), revisit for memory at scale.
- Version pins: agentOS exact-pin at current stable + `sandbox-agent`
  exact-pin; Flue 2.0.1 → 2.0.3 bump check alongside.

## Variant E candidate: computer-on-celld (added 2026-08-08)

`denoland/celld` (Apache-2.0, alpha; single Rust binary, signed releases) is
**self-hosted distributed Durable Objects**: one SQLite per cell, replicated
to an S3-compatible bucket (MinIO works), nodes coordinate through the
bucket alone (object-storage CAS, no control plane), idle cells hibernate.
Its Cloudflare-compat table covers cloudflare/computer's load-bearing
joints: DO SQLite storage, alarms, **inbound hibernatable WebSockets**
(computerd's capnweb channel), JS RPC/service bindings, and even Worker
Loader (experimental, `CELLD_WORKER_LOADER`) for the isolate backends.

So **computer-on-celld = the fully self-hosted form of variant C**: the
Workspace DO on celld on gradient, computerd FUSE-projecting it into a
local Docker container, state authoritative in MinIO. It would deliver
pre-built what Phase 2 otherwise constructs: S3-authoritative workspace,
projection-into-sandbox, hibernating per-agent state. It also dissolves the
actor question — celld IS the self-hosted actor substrate (no rivetkit).

Why it is not the Phase-2 default: maturity stacking — celld self-describes
as alpha, computer as "NOT suitable for production," the isolate tier is
experimental², and their mutual conformance is unproven (mitigation: celld
fails loudly on unsupported APIs, never silently). agentOS is one preview
dep with a stable line and a shipping light-VM tier. Hibernation economics
also stay theoretical until Phase-5 push leases exist — an agent cell
holding an outbound Nostr WebSocket never hibernates (celld documents
outbound sockets pinning residency).

**Watch-triggers for the compat spike**: computer exits preview, celld
exits alpha, or Phase-5 push leases land. Any one justifies a
computer-on-celld spike as the potential end-state substrate.

## Spike order

1. `docker()` egress/network config (the gating unknown)
2. macOS sidecar support (shapes where dev happens)
3. `buzz` binding + guest wrapper (+ credential-helper seam)
4. S3-mount git behavior on MinIO
5. Failure-UX + workspace projection into the Docker tier (bind-mounted
   JuiceFS-class mount of the agent's S3 prefix — the cloudflare/computer
   pattern — instead of copy-through-`/mnt/sandbox`)

## References

- agentOS: github.com/rivet-dev/agentos (Apache-2.0, preview) — v0.2.15
  stable / v0.2.16-rc.2 checked 2026-08-08; docs at agentos-sdk.dev
  (403s to plain fetchers; read from `website/public/docs/` in the repo)
- Packages: `@rivet-dev/agentos`, `@rivet-dev/agentos-core`,
  `@rivet-dev/agentos-sandbox` + `sandbox-agent`, `@agentos-software/*`
- Ours: [AGENTOS_HOST_PLAN.md](AGENTOS_HOST_PLAN.md) (plan of record),
  [`flue-host/`](flue-host/) (v1 T2 tier, live on gradient)
- Session memory: `rivet-agentos-compute-substrate` (evaluation history)

---

# Ecosystem Scan (2026-08-09)

Three parallel research passes over Cloudflare OSS, sandboxing/exec
alternatives, and the workspace/actor/plumbing layer — every claim below
verified from primary sources (repos, docs, npm). Verdict vocabulary:
ADOPT-CANDIDATE / STEAL-PATTERN / WATCH (with trigger) / SKIP.

## Corrections to earlier sections

1. **Flue is not Cloudflare's.** `@flue/runtime` → **withastro/flue**
   (Astro org, Apache-2.0, 7.8k★, 2.0.3 current, very active; built on
   `@earendil-works/pi-agent-core`). Flurry's survey mislabeled it; it
   ships a Cloudflare deploy target + `cloudflareSandbox()` adapter, hence
   the confusion. Better still: **the sandbox adapter surface is public,
   documented, and proven** — `SandboxFactory`/`SandboxDriver` +
   `sandboxFromDriver()`, with ~10 third-party adapters in ecosystem docs
   (boxd, cloudflare-computer, daytona, e2b, modal, vercel, …). Writing our
   own adapter is a beaten path; no fork needed for `useSandbox`.
2. **Rivet's "merging fork APIs upstream" is not in evidence.** Their
   target-authoring PR (withastro/flue#515) was closed unmerged → stalled
   discussion #516. Only deploy *targets* are non-pluggable; the sandbox
   seam we need is already open. WATCH #516.
3. **`sandbox-agent` role correction** (affects the Phase-2 shape §5
   wording): it is an in-sandbox HTTP/SSE binary for hosting *entire
   coding agents* (Claude Code/Codex/… — agent-in-sandbox, T1 topology)
   plus provider spin-up helpers; agentOS uses it as the control plane for
   sandbox mounting. It is not itself a sandbox and contributes **zero
   egress control**; also ~7 weeks quiet. Any Docker heavy tier keeps the
   egress problem ours regardless of this component.
4. **MinIO community edition is dead** — minio/minio archived 2026-04-25
   (verified `archived: true`), company moved to paid AIStor. **Our prod
   object store (relay media + planned workspace store) is unmaintained
   software.** This is bigger than agent hosting; see workspace verdicts.

## Gradient host facts (verified live 2026-08-09)

Kernel 6.17 (Landlock ABI current, `landlock` in active LSMs);
`unprivileged_userns_clone=1` **but** `apparmor_restrict_unprivileged_userns=1`
(Ubuntu restriction — bwrap's apt AppArmor profile should exempt it; smoke
before relying); `/dev/kvm` present (root:kvm); `bwrap` installed; `socat`
missing (apt). **No host constraint eliminates any candidate below.**

## Light exec tier — the option space widened

| Option | Isolation | Native binaries (`buzz`, git) | Egress control | Verdict |
|---|---|---|---|---|
| **srt** (anthropic-experimental/sandbox-runtime, Apache-2.0, 4.9k★, v0.0.71, very active, beta) | bwrap namespaces, per-command FS scoping | **yes — just run** | **best surveyed**: deny-by-default, domain allowlist (+ports), netns removal + UDS-bridged filtering proxy, credential injection, violation feedback to the model | **ADOPT-CANDIDATE — new default first step** |
| just-bash via Flue's built-in `bash()` (vercel-labs, Apache-2.0, 4.1k★, beta) | same-process semantic sandbox (no boundary) | no (≈90 WASM/TS cmds; **no git**) | allowlisted `curl` w/ host-side credential injection; no other net | ADOPT-CANDIDATE only as a zero-infra *supplement* (quick turns); never the security story |
| agentOS VM (prior default) | V8 isolate + virtualized kernel — strongest | no (bridge or WASI required) | default-deny, per-VM policy | demoted to **isolate-grade upgrade option** |
| workerd + miniflare (Apache-2.0; DO SQLite `localDisk` EXPERIMENTAL; Worker Loader present in OSS) | V8 isolates ("not a hardened sandbox" per own README) | no | n/a directly | WATCH — enables a **computer-on-workerd** single-node variant beside celld |
| nono (nolabs-ai, Apache-2.0, 3.6k★, Sigstore team) | Landlock (no userns needed) | yes | proxy allowlists + **L7 credential broker, child-sandboxes per delegated tool** | STEAL-PATTERN (broker = the refined buzz-bridge shape); fallback ADOPT if AppArmor blocks bwrap |
| codex sandbox internals (openai/codex, Apache-2.0) | bwrap (default) / legacy Landlock+seccomp | yes | netns + UDS proxy + seccomp AF_UNIX lockdown | STEAL-PATTERN (flag recipes; Rust crates vendorable) |

**Key consequence: the srt path makes the buzz-CLI host-bridge and the
WASI build both optional.** Under srt the agent key still enters the exec
env (Ring 2 as today) but FS+egress containment improves enormously for
two lines of integration (a `SandboxFactory` variant spawning via `srt`).
The nono-style signing broker (sandboxed `buzz` asks a host broker for
signatures) is the later refinement that removes the key from Ring 2 —
equivalent credential posture to the agentOS bridge, on the native tier.

## Heavy exec tier

| Option | Shape | Egress story | Verdict |
|---|---|---|---|
| **OpenSandbox** (Alibaba, Apache-2.0, 12.4k★ in 8 months, very active) | Docker locally, K8s at scale; SDKs + open Sandbox Protocol | **built-in per-sandbox egress component + credential vault**; documented gVisor/Kata/Firecracker hardening path | **ADOPT-CANDIDATE** — strongest successor in the niche Daytona vacated; depth of egress enforcement unaudited |
| cloudflare/sandbox-sdk container image (Apache-2.0, beta) | Ubuntu 22.04 + Node 24 + Bun + **git** + curl + port-3000 HTTP control server; `-python` variant | none built-in | STEAL-PATTERN — vendor the image/protocol as our Docker-tier base; Flue's first-party `cloudflareSandbox()` adapter is modeled on it |
| plain Docker + srt-style proxy | DIY | ours to build (netns + UDS proxy) | baseline fallback |
| microsandbox (superradcompany, Apache-2.0, 7.2k★, beta) | libkrun **microVMs**, no daemon, OCI images, **first-class Rust SDK** | per-sandbox `allowed_hosts`/ports + secret-scoping (enforcement unverified) | **ADOPT-CANDIDATE (spike)** — KVM verified present on gradient |
| CubeSandbox (Tencent, 11k★, very active) | RustVMM/KVM microVMs, E2B-SDK-compatible, &lt;60ms cold | eBPF isolation + **L7 proxy w/ per-domain/path/method policy + credential injection** — best on paper | WATCH — **license NOASSERTION** (custom Tencent text); blocked on legal clarity |
| gVisor (19k★) | runsc under Docker, per-container opt-in, **no KVM needed** (systrap) | n/a (adds syscall boundary) | WATCH — pre-stage for the hostile-tenant phase; trivial to stage now |
| Kata (8.5k★, 4.0.0) | real microVM per container, needs KVM | n/a | WATCH — only if gVisor compat fails |
| E2B infra | Firecracker, but self-host = GCP/AWS Terraform topology; "general Linux machine" explicitly unchecked | theirs | SKIP (cloud-shaped; re-check if the checkbox flips) |
| Daytona | **upstream dead** (June 2026, moved private; AGPL) | — | SKIP |
| k8s agent-sandbox | needs Kubernetes | — | SKIP (we run plain Docker) |

## Workspace / storage

| Option | Git-safety | Coherence (host mount ↔ S3 view) | Verdict |
|---|---|---|---|
| **JuiceFS** (Apache-2.0 since 1.0/1.2, 14.3k★, active) | **best surveyed**: pjdfstest pass, atomic rename, flock+fcntl; metadata in our existing Redis or Postgres | close-to-open; ~1s attr-cache staleness across mounts; single-writer-per-agent is safe. **Raw S3 view is chunks** — the agentOS s3-plugin leg must go through `juicefs gateway` | **ADOPT-CANDIDATE** |
| **SeaweedFS** (Apache-2.0, 34k★, ~2 rel/mo) | claims flock/rename/hardlinks; **no pjdfstest evidence + past git-corruption issues** (all closed) → pilot required | **native**: S3 API and FUSE are two doors to one filer namespace, 1:1 mapping — no gateway needed | **ADOPT-CANDIDATE (co-equal)** — and it **replaces MinIO**, which is now the succession play |
| rclone mount / mountpoint-s3 | not git-safe (async upload, non-atomic rename, no locks) | — | SKIP (door closed) |
| s3ql (GPL-3.0, active) | full POSIX, atomic rename | **one mount per fs** — host-mount-only designs | WATCH (niche) |
| Garage | S3-only (no FUSE), AGPL | — | noted as MinIO successor iff object-store-only |

**MinIO succession is now a forced decision** (archived upstream, CVE
exposure grows with time): either pin/fork-freeze consciously, or
consolidate onto SeaweedFS (object store + git-capable FS in one move —
one system serves Blossom media AND agent workspaces), or move media to
Garage and workspaces to JuiceFS-on-(frozen-MinIO→successor). Decision
belongs with Kevin; a git-workload pilot (clone/rebase/gc loop) on
JuiceFS-on-MinIO vs SeaweedFS settles the technical half.

## Actor / durability / plumbing

- **Rivet engine self-hosted**: verdict unchanged — actor *code* still
  executes in your backend via rivetkit (TS rewrite of buzz-acp); the
  engine only orchestrates. celld remains the DO-style candidate. SKIP.
- **Restate** (BSL 1.1 — internal use permitted; single Rust binary; Rust
  SDK active): dodges half the workflow-engine criticism (journaled plain
  code, virtual objects), but unbounded-loop journal growth is unaddressed
  → wrong for the agent loop. WATCH — trigger: buzz-workflow ever needing
  crash-safe exactly-once multi-step pipelines.
- **Temporal**: SKIP (platform-weight: 4 services + DB + ES; determinism
  constraints; wrong shape for infinite loops on one box).
- **capnweb as bridge plumbing**: SKIP the library (JS-only official;
  community Rust port dead since 2025-09, license NOASSERTION; pre-1.0
  protocol churn — a Workers compat flag changed param-stub semantics
  Jan 2026). STEAL the capability-scoping idea: the bridge socket handed
  to a sandbox is already scoped to that agent's identity. For transport:
  **JSON-RPC 2.0 over UDS** (jsonrpsee on Rust ends; one import on the
  Node end) or tarpc for Rust↔Rust.
- **container2wasm**: SKIP (full-machine emulation without JIT — a demo,
  not plumbing).
- **WASI buzz-cli realism (mid-2026)**: plausible *only* for plaintext
  `ws://` to a host-local relay — tokio 1.51 has official wasip2 support
  (current-thread), tungstenite works over it, but **TLS is the wall**
  (ring/aws-lc don't link; rustls-rustcrypto not production-grade;
  wasi:http can't carry WebSocket upgrades) and reqwest has no wasip2
  support. WATCH — re-check at WASI 1.0. The srt path makes this fallback
  mostly moot.

## Revised recommendation (supersedes "Phase-2 shape" §1–5 ordering)

The scan changes the first move. New ladder, cheapest-real-win first:

1. **srt-wrap the existing local tier now** — a `SandboxFactory` variant
   spawning tool exec via `srt` (bwrap): per-agent FS scoping + deny-by-
   default domain-allowlist egress on the *current* fleet, native `buzz`
   + git untouched, no bridge, no WASI, no new runtime. Interim-posture
   line item ("containment = env allowlist only") retired. Prereqs on
   gradient: `apt install socat`, AppArmor/bwrap smoke. Risk: 0.0.x churn
   — pin + wrap behind the engine seam like everything else.
2. **Heavy tier**: spike OpenSandbox vs plain-Docker+srt-proxy vs
   microsandbox (KVM verified). Steal the sandbox-sdk container image as
   the base either way. Egress enforcement depth is the acceptance test.
3. **Workspace + MinIO succession**: JuiceFS-on-MinIO vs SeaweedFS pilot
   (git clone/rebase/gc loop; two-mount coherence). Kevin decides the
   succession strategy; the pilot informs it.
4. **agentOS tier**: becomes the *isolate-grade upgrade* (V8 boundary,
   WASM-only tools, bridge for `buzz`) — adopt when prompt-injection
   containment for the light tier warrants a true boundary, or skip if
   srt(+gVisor heavy) proves sufficient. The earlier factory/bridge specs
   in this doc remain valid when triggered.
5. **Signing broker refinement** (nono pattern): move `buzz` signing to a
   host broker so the nsec leaves Ring 2 even on the native tier.
6. **Variant E watch unchanged** (computer-on-celld; now plus
   computer-on-workerd as a second self-hosted expression — experimental
   DO storage, single-node).

## Revised spike order

1. srt smoke on gradient: socat install, AppArmor/bwrap check, wrap one
   Flue turn, verify domain-allowlist egress + violation messages
2. Workspace pilot: JuiceFS vs SeaweedFS git-loop bench (+ two-mount
   coherence); feeds the MinIO succession decision
3. Heavy-tier spike: OpenSandbox egress-depth audit vs Docker+proxy;
   microsandbox if KVM tier appeals
4. gVisor pre-stage (runsc + daemon.json runtime entry; per-container
   opt-in, no KVM needed)
5. (conditional) agentOS factory + bridge / signing broker — on trigger
