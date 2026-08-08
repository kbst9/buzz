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

## Open spikes before committing

- Bridge design: transport (UDS vs virtual-network loopback), and whether
  bindings can present as a plain `buzz` command in `PATH`.
- S3-mount git behavior under our MinIO (their block store should be
  git-safe; verify clone/commit/push + crash-consistency empirically).
- agentos-core persistence semantics standalone (actor storage is the
  default story; core-standalone durability needs verification — the S3
  mount may make it moot for the workspace).
- WASI buzz-cli feasibility (only if the bridge disappoints).
- Version pins: agentOS exact-pin at current stable; Flue 2.0.1 → 2.0.3 bump
  check alongside.

## References

- agentOS: github.com/rivet-dev/agentos (Apache-2.0, preview) — v0.2.15
  stable / v0.2.16-rc.2 checked 2026-08-08; docs at agentos-sdk.dev
  (403s to plain fetchers; read from `website/public/docs/` in the repo)
- Packages: `@rivet-dev/agentos`, `@rivet-dev/agentos-core`,
  `@rivet-dev/agentos-sandbox` + `sandbox-agent`, `@agentos-software/*`
- Ours: [AGENTOS_HOST_PLAN.md](AGENTOS_HOST_PLAN.md) (plan of record),
  [`flue-host/`](flue-host/) (v1 T2 tier, live on gradient)
- Session memory: `rivet-agentos-compute-substrate` (evaluation history)
