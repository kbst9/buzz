# M3 heavy-tier audit — OpenSandbox vs Docker+srt-proxy vs microsandbox

**Date:** 2026-08-10 · **Host:** gradient (bare metal, /dev/kvm present, nested
virt on, AMD Threadripper 7975WX 32c/64t) · **Method:** empirical spike of the
Docker+srt-proxy baseline on gradient + primary-source research on the two
ADOPT-CANDIDATEs (sources cited in the per-candidate notes). Read-only — **no
prod mutation**. Informs **park point 5 (heavy-tier selection sign-off)**.

## The question

The light tier (srt, M1) is live. The heavy tier is a *stronger* isolation
option for higher-risk work. The audit closes the two gaps the analysis
flagged — OpenSandbox "egress depth unaudited", microsandbox "enforcement
unverified" — against the known Docker+srt-proxy baseline, on three axes:
**isolation depth × egress depth × workspace-projection (SeaweedFS) fit**,
plus operational weight and maturity.

## Comparison

| | Docker + srt-proxy (baseline) | OpenSandbox (Alibaba) | microsandbox (libkrun) |
|---|---|---|---|
| **Isolation** | Docker namespaces — **shared kernel** | runc default (shared kernel); gVisor/Kata/FC as **server-wide** flags | **True KVM microVM, separate guest kernel** — strongest |
| **Egress mechanism** | no-route (internal net) + allowlist proxy | nftables L3/L4 in-netns via CAP_NET_ADMIN sidecar (`dns+nft` mode) | libkrun **TSI** — no guest NIC; host userspace stack (smoltcp) polices all traffic |
| **Egress depth** | deny-by-default, **proven on gradient** (allowed reached, denied → 403) | deep **only** in opt-in `dns+nft`; default `dns` mode raw-IP-bypassable | deny-by-default **capable** (must set `defaultEgress:deny`); ships allow+SSRF-filter; then raw-IP-robust |
| **Egress placement** | host proxy (netns has no route) | in the sandbox's own netns (shared kernel) | **host/VMM boundary — guest can't cooperate to defeat** (strongest) |
| **Credential vault** | none (agent key in Ring 2 as today) | strong, but **HTTP-auth-header shaped** | strong (placeholder + host-side TLS swap), bound per-host |
| **…covers local Nostr nsec signing?** | n/a | **No** (outbound-HTTP only) | **No** (outbound-HTTP only) |
| **SeaweedFS projection** | **proven** (Docker bind-mount, M2) | host bind-mount first-class; FUSE needs rshared+allow_other (validate) | virtio-fs bind mount — live FUSE **plausible not proven**, least-mature layer |
| **gVisor hardening** | M4 pre-stage (`--runtime=runsc`), per-container | first-class **but ⊥ egress sidecar** (no nat table → 400); Kata for both | n/a (already a VM) |
| **Single-node weight** | lowest — Docker + the proven proxy | Python FastAPI server + SQLite + 2 containers/sandbox | one-curl install; real microVM/instance (~300ms, RAM floor); **needs kvm-group prep** |
| **Maturity / license** | ours; stable | Apache-2.0, **server 0.2.x / SDKs pre-1.0**, new (Mar 2026), churn | Apache-2.0, **v0.6.8 beta, 2–4 releases/week**, breaking churn |
| **Cold start** | container ms | container ms | ~300 ms (microVM) |

## Findings

1. **No candidate's egress is materially *deeper* than the baseline.** All
   three are deny-by-default-capable and, configured correctly, close the
   raw-IP hole. microsandbox has the *best placement* (host/VMM boundary, guest
   can't defeat it); OpenSandbox's is only deep in its non-default `dns+nft`
   mode; the baseline's is host-proxy over a no-route netns — **proven on
   gradient**. Egress depth does not discriminate between them for our use.

2. **Isolation is where they differ, and it maps to threat model.** Docker
   (shared kernel, +gVisor via M4) suits **our own, non-hostile agents**.
   microsandbox's hardware-VM boundary is **stronger but overkill** until we
   host untrusted/hostile code — which is precisely the **M5 isolate-tier
   trigger**, not the current heavy tier.

3. **Neither credential vault solves our actual key problem.** Both scope
   *outbound-HTTP* credentials host-side; neither covers **in-process Nostr
   nsec signing**. Getting the agent key out of Ring 2 still needs the
   nono-style **signing broker** (M5), independent of the tier choice.

4. **Projection favors the baseline.** Docker bind-mounting a SeaweedFS
   workspace is proven (M2). OpenSandbox supports host bind-mounts but its
   FUSE case is unvalidated; microsandbox's FUSE-behind-virtio-fs is its
   *least-mature* subsystem (documented single-file/unix-socket I/O errors) —
   a real risk for a git-heavy agent workspace.

5. **Weight and churn favor the baseline.** Docker+srt-proxy reuses the proven
   M1 egress and the cloudflare sandbox-sdk image as base. OpenSandbox is a
   pre-1.0 Python control-plane framework with a gVisor⊥egress coupling to
   design around; microsandbox is fast-churning beta needing kvm-group host
   prep and a per-adoption projection spike.

## Recommendation direction (park point 5 is Kevin's)

**Adopt Docker + srt-proxy as the M3 heavy tier**, with the cloudflare
sandbox-sdk image as the base and **gVisor (M4) as the opt-in syscall-hardening
layer**. It matches our own-agent threat model, its egress is proven, its
SeaweedFS projection is proven, and it carries the least operational weight and
third-party churn.

**Reserve microsandbox as the M5 isolate-tier candidate** — its hardware-VM
boundary is the right tool if/when a hostile-tenant or prompt-injection
containment need triggers M5. Adopting it then requires a pre-adoption spike of
(a) `defaultEgress:deny` allowlist enforcement and (b) live SeaweedFS-into-
microVM projection — both flagged plausible-but-unproven.

**Do not adopt OpenSandbox**: it is a heavier framework whose egress is no
deeper than the baseline, whose strongest isolation conflicts with its own
egress enforcement, and whose credential vault does not cover our key use —
net negative weight for our posture. (CubeSandbox stays WATCH — license
unresolved.)

**Independent of the tier:** the agent-key-out-of-Ring-2 goal is served by the
signing broker (M5), not by any tier's credential vault.
