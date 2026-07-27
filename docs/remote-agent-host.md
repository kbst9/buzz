# `buzz-agent-host` — community-authorized remote agent execution

**Status:** design, not yet implemented
**Branch:** `feat/agent-host-daemon`
**Verified against:** `kbst9/buzz` @ `37420764`
**Supersedes (eventually):** `crates/buzz-backend-ssh` — see [Migration](#12-migration-from-buzz-backend-ssh)

---

## 1. What this is

A daemon that runs on a machine you own, joins a Buzz community as a member with
its own keypair, advertises which agent runtimes it can launch, and deploys
agents on behalf of **any community member you authorize** — with no SSH keys, no
shell access, and no sudo granted to anyone but the daemon itself.

Desktop remains the place agents are created and configured. Only execution moves.

```
Buzz Desktop                     relay                    your server
┌──────────────┐                                       ┌──────────────────────┐
│ agent dialog │                                       │  buzz-agent-host     │
│  "Run on:    │   30178 announce (durable) ◀──────────│  (community member)  │
│   gradient"  │──▶ 24300 control (ephemeral, NIP-44)─▶│                      │
└──────┬───────┘                                       │   systemd units      │
       │ op:deploy (stdio)                             │   └─ buzz-acp ──┐    │
┌──────▼────────────┐                                  └─────────────────┼────┘
│ buzz-backend-host │  thin: forwards, signs, awaits                     │
└───────────────────┘                                    agent joins ────┘
```

## 2. The gap it closes

| Capability | `buzz-backend-ssh` (today) | `buzz-agent-host` |
|---|---|---|
| Agents run on an always-on server | ✅ | ✅ |
| Created/configured from Desktop | ✅ | ✅ |
| A second person can deploy | ❌ needs an SSH key + sudo on your box | ✅ community membership |
| Revoking that person | pull an SSH key **and** relay membership | remove from the community |
| Arbitrary command execution | effectively yes (it runs a shell script) | **no** — runtime ids only |
| Stop / undeploy / logs | ❌ no such op | ✅ |
| Runtime discovery | SSH probe + local cache | the host announces authoritatively |
| Identity stability | unit id is a slug of the name; rename orphans it | unit id is the agent pubkey |

The deciding one is row 3. Everything else in Buzz is gated by nostr membership;
the SSH provider is gated by SSH keys. Those are two unrelated authorization
systems, so agent management is the one capability that cannot be delegated the
way channels, media, and attestation already are.

## 3. Why not the alternatives

Each was considered and rejected against the codebase, not in the abstract.

**Watch `kind:30177` (managed agent) and reconcile declaratively.** The
Kubernetes-shaped design, and it cannot work: `agent_events.rs:126` states the
projection type "physically cannot represent `private_key_nsec`, `auth_tag`,
`env_vars`, `backend`, `agent_command`". 30177 is cross-device *definition* sync
and is deliberately secret-free. Routing deploy through it would mean either
defeating that guard or deploying agents with no identity.

**Reuse the job protocol (43001–43006).** `kind.rs:455` scopes it as the
"Agent job protocol… Buzz requires auth chains (depth ≤ 3, breadth ≤ 10)" —
agent-to-agent work delegation. It is durable and feed-visible, so a deploy
carrying an nsec would persist in the event log forever.

**HTTP service + NIP-98.** Works, and NIP-98 is already used for the relay's REST
bridge. But it needs a new listener, a new ingress hostname, and its own
membership check, duplicating what the relay already enforces. The relay is the
one thing every participant is already connected to and authorized against.

**Keep SSH, hand out keys.** Rejected: `op:deploy` passes the agent private key
to the provider, and the install path needs passwordless sudo. "Can manage
agents" would imply "has root-capable shell and sees agent identities."

## 4. Design principles

Taken from Buzz's own architecture rather than invented:

1. **Everything is a signed event.** No side-channel control plane.
2. **Membership is the only gate.** Authorization derives from the community you
   already curate; revocation is removal.
3. **Secrets never persist.** Anything carrying an nsec travels on an ephemeral,
   encrypted kind — the [NIP-AO](nips/NIP-AO.md) pattern.
4. **Capability, not shell.** The client names a runtime *id*; the host owns the
   mapping to a command line. There is no path from a remote message to an
   arbitrary process.
5. **The host is a member, not infrastructure.** It has a keypair, a profile, and
   a presence, exactly like an agent or a human.

## 5. Protocol

### 5.1 Host announcement — `kind:30178`, durable, secret-free

Parameterized replaceable (NIP-33), addressed by `(host_pubkey, 30178, d=host-id)`.
30178 is the next free slot after `KIND_MANAGED_AGENT` (30177) and sits with the
rest of the agent family.

```jsonc
{
  "kind": 30178,
  "pubkey": "<host_pubkey>",
  "tags": [["d", "gradient"], ["h", "<community-channel-or-omitted>"]],
  "content": {
    "label": "gradient",              // shown in Desktop's host picker
    "version": "0.1.0",
    "runtimes": [                     // the ONLY launchable set
      { "id": "hermes", "label": "Hermes 0.19.0", "users": ["hermes","hermesgpt"] },
      { "id": "claude", "label": "Claude Code",   "users": ["buzz-claude"] }
    ],
    "capacity": { "max_agents": 32, "deployed": 5 },
    "accepts_from": "members" | "allowlist"
  }
}
```

Replaceable means the current state is always one event; no history to reconcile.
Secret-free, so persisting it is fine — and it is exactly the "remote compute
manager index" that motivated this design, following the mesh's signed
discovery-note pattern.

### 5.2 Control channel — `kind:24300`, ephemeral, NIP-44

Modelled directly on [NIP-AO](nips/NIP-AO.md) kind 24200: ephemeral range
(20000–29999), so **relays MUST NOT persist it**, with NIP-44 v2 content. 24300
is free and adjacent to 24200, signalling the same family.

```jsonc
{
  "kind": 24300,
  "pubkey": "<sender>",
  "content": "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p",    "<recipient_pubkey>"],   // host for requests, owner for replies
    ["host", "<host_pubkey>"],
    ["frame","request" | "reply"],
    ["req",  "<uuid>"]                // correlation
  ]
}
```

Plaintext request:

```jsonc
{ "op": "deploy",
  "agent": { /* the 16-field deploy payload, verbatim */ },
  "target": { "runtime": "hermes", "user": "hermesgpt", "workdir": null },
  "auth_tag": ["auth","<owner_pubkey>","","<sig>"] }
```

Ops: `deploy` · `status` · `stop` · `start` · `undeploy` · `logs`.
The last four are what the SSH provider structurally cannot offer — the provider
contract has no such op, and here they are ordinary messages.

Replies carry `{ok, agent_id, state, detail}`; `logs` returns a bounded tail.

**Why the nsec is safe here.** Ephemeral: never written to the relay's store.
Encrypted: NIP-44 to the host's pubkey, so the relay operator sees ciphertext.
Compare the durable alternatives, where an agent key would sit in the event log
permanently.

### 5.3 Idempotency and identity

The unit id is **the agent's pubkey**, not a slug of its name. Renaming an agent
in Desktop then updates the same unit instead of orphaning it — a documented
limitation of the SSH provider, fixed by construction.

## 6. Authorization

Three independent checks, all cheap:

1. **Transport** — the host connects with NIP-42. If it presents a NIP-OA
   credential it gains *virtual membership* per [NIP-AA](nips/NIP-AA.md): "if the
   owner's membership is later revoked, the agent's next connection attempt fails
   automatically — no separate cleanup required." Your relay already runs with
   `BUZZ_ALLOW_NIP_OA_AUTH=true`.
2. **Sender** — the request's `pubkey` must be a current relay member. The host
   verifies against the membership roster it already receives (`kind:13534`).
3. **Ownership** — the enclosed `auth_tag` must verify via
   `buzz_sdk::nip_oa::verify_auth_tag` against the agent being deployed, and the
   owner it names must equal the sender. This is the same crate function the
   relay uses, so the two can never disagree.

Plus host-side policy: an `accepts_from` allowlist, and a per-owner agent quota.

The result: **authorizing a teammate is adding them to the community**, and
de-authorizing is removing them. No second credential system.

## 7. Security analysis

### 7.1 What this removes

- No SSH keys distributed to teammates
- No sudo or shell granted to anyone but the daemon
- **No arbitrary command execution.** The SSH provider runs a generated shell
  script; anyone able to deploy through it can run anything. Here the wire format
  carries a runtime *id* that must appear in the host's own announcement. A
  compromised owner key can deploy an agent — it cannot run `curl … | sh`.

### 7.2 What this adds

A privileged daemon written for this purpose, versus SSH, which is hardened and
audited. That is a real trade and should be stated plainly: a bug in the auth
path is root-adjacent. Mitigations:

- **Least privilege.** The daemon runs as a dedicated `buzz-host` user, not root,
  with a narrowly scoped sudoers entry:

  ```
  buzz-host ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload, \
    /usr/bin/systemctl enable --now buzz-acp-*, \
    /usr/bin/systemctl disable --now buzz-acp-*, \
    /usr/bin/systemctl is-active buzz-acp-*, \
    /usr/bin/buzz-host-install
  ```

  `buzz-host-install` is a tiny helper that writes only into `/etc/buzz-agents`,
  `/usr/local/share/buzz-agents/prompts`, and `/etc/systemd/system/buzz-acp-*`.
  It takes no free-form path.
- **Zero-root variant.** Run everything as `systemctl --user` units under one
  lingering account. No sudo at all, at the cost of per-agent user isolation.
  Offer as a config choice; document the trade.
- **No template escape.** Unit and env rendering is the existing, tested
  `render.rs`, which already rejects newlines, control characters, and
  comma-bearing arguments.
- **Bounded everything.** Request size, per-owner quota, concurrent deploys, log
  tail length.
- **Audit.** Every accepted request is logged with sender, op, agent pubkey, and
  outcome. Optionally mirrored to a channel so the community can see it.

### 7.3 Residual risk

An owner key compromise still yields agent deployment as that owner — and agents
have unsandboxed shells. That is inherent to the product, not to this design, and
is the reason each agent should run as its own unprivileged user.

## 8. Components

```
crates/buzz-agent-host/        the daemon
  src/announce.rs              build + publish kind:30178
  src/control.rs               24300 subscribe, decrypt, dispatch
  src/authz.rs                 membership + NIP-OA + policy
  src/units.rs                 systemd lifecycle (via the install helper)
  src/reconcile.rs             adopt existing units on startup
crates/buzz-agent-unit/        shared rendering, extracted from buzz-backend-ssh
crates/buzz-backend-host/      thin Desktop-side provider
```

`render.rs` moves to `buzz-agent-unit` and is consumed by both providers, so the
env/unit format has exactly one definition. That extraction is the only change
the SSH provider needs.

### 8.1 Desktop side stays thin

`buzz-backend-host` does no filesystem work and holds no config:

1. `op:info` → connect to the relay, query `kind:30178`, return a schema whose
   `host`, `runtime`, and `user` fields are **enums built from live
   announcements**. No local config file, no SSH probe, no cache.
2. `op:deploy` → wrap the payload in a 24300 request, publish, await the reply,
   return `{agent_id}`.

It needs a nostr identity to sign with; it uses the **agent's own key** from the
payload and encloses the `auth_tag` as proof of ownership — both already present,
so no new credential is introduced anywhere in the system.

## 9. Implementation plan

Each step is independently testable and leaves the tree working.

**Step 1 — kinds and envelopes.** Add `KIND_AGENT_HOST_ANNOUNCE = 30178` and
`KIND_AGENT_HOST_CONTROL = 24300` to `buzz-core`. Builders and parsers in
`buzz-sdk`, mirroring `nip_oa.rs`'s shape.
*Accept:* round-trip tests; ephemeral kind confirmed unpersisted by the relay.

**Step 2 — extract `buzz-agent-unit`.** Move `render.rs` out of
`buzz-backend-ssh`; both crates depend on it. Pure refactor.
*Accept:* the SSH provider's 36 tests pass unchanged.

**Step 3 — daemon skeleton: connect, announce, reconcile.** Joins the relay,
publishes 30178 from a config listing runtimes and users, adopts existing units.
No control channel yet.
*Accept:* announcement visible on the relay; restart is a no-op.

**Step 4 — control: `status` and `logs`.** Read-only ops first, so the auth path
is exercised before anything can mutate the system.
*Accept:* a signed `status` from an authorized owner returns unit state; an
unauthorized sender is rejected and logged.

**Step 5 — `deploy`.** Add the install helper and sudoers entry. Reuses Step 2's
rendering and the SSH provider's proven preflight-and-verify sequence.
*Accept:* an agent deployed over the control channel answers an `@mention`.

**Step 6 — `stop` / `start` / `undeploy`.** Closes the lifecycle gap the provider
protocol never had.
*Accept:* full create → stop → start → remove cycle leaves no residue.

**Step 7 — `buzz-backend-host` provider.** Thin forwarder; enums from live
announcements.
*Accept:* Desktop's "Run on" lists hosts discovered from the relay, with no local
config present.

**Step 8 — multi-owner.** Allowlist, quotas, audit mirroring.
*Accept:* a second community member deploys an agent; removing them from the
community immediately blocks the next request.

**Depends on:** the two Desktop fixes from `feat/backend-ssh-provider` (the probe
effect that erased typed config, and `enum` dropdown rendering). Step 7's UX
assumes both. Merge that branch first, or rebase onto it.

## 10. Open questions

1. **Reply latency.** `op:deploy` has a 600s budget; a relay round trip is fast,
   but the host may take minutes to install. Stream progress as interim replies,
   or return `accepted` immediately and let Desktop's presence axis show
   liveness? The two-axis status model (`runtime.rs:1389`) suggests the latter.
2. **Host trust on first use.** Anyone can publish a 30178. Desktop should show
   the host's pubkey and require explicit acceptance, or restrict to hosts whose
   pubkey is an admin — otherwise a malicious member could advertise a host and
   harvest agent keys. **This must be resolved before Step 7.**
3. **Should the host also own attestation?** Currently Desktop mints the
   NIP-OA tag. Leaving it there keeps the host out of the identity business.
4. **Multi-community hosts.** One daemon serving several communities needs
   per-community policy and quotas. Defer.

## 11. Relationship to upstream

Nothing here requires forking Desktop. It uses the existing `buzz-backend-*`
contract, which remains undocumented and unannounced — the standing risk noted in
[remote-runtime-agents.md](remote-runtime-agents.md).

Full catalog integration (remote runtimes appearing in Desktop's *own* runtime
dropdown rather than in provider config) still needs the upstream
`runtimes: [...]` change. This design makes that change *more* attractive: the
host already publishes exactly that data in its announcement.

## 12. Migration from `buzz-backend-ssh`

They coexist. The SSH provider is one binary and a config file, and it stays
useful for hosts you do not want to run a daemon on. Migration per agent is:
deploy through the host, then remove the old unit. Both write the same env and
unit format once Step 2 lands, so there is nothing to convert.
