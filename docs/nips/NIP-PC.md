NIP-PC
======

Agent Provider Credentials
--------------------------

`draft` `optional` `relay`

This NIP defines two event kinds for delivering AI-provider credentials (API
keys and OAuth token pairs) from an agent's owner to the harness process
running that agent, and for the agent to report non-secret credential health
back. Delivery events are NIP-44 encrypted, addressable, and persisted, so a
harness that boots while the owner's client is offline still fetches its
current credentials from the relay.

## Motivation

Hosted agents need model-provider credentials, and the owner's client (e.g. a
desktop app) is the natural place to configure them. Environment files on the
host require out-of-band provisioning and cannot be rotated without shell
access. Modeling delivery as an addressable encrypted event gives owners a
pure-client configuration surface with relay-mediated durability: rotation and
revocation are replacements at a deterministic coordinate (NIP-33 LWW), the
recipient agent fetches current state on connect, and the relay never sees
plaintext.

## Definitions

- **Agent / Owner**: as in [NIP-AM](NIP-AM.md). The relay knows the mapping
  (`users.agent_owner_pubkey`), materialized at NIP-OA auth or invite claim.
- **Provider id**: a lowercase slug naming a model provider (`anthropic`,
  `openai-codex`, `xai`), matching `^[a-z0-9][a-z0-9_-]{0,31}$`.
- **Credential object**: a JSON object with a `type` of `"api_key"`
  (`{"type":"api_key","key":…}`) or `"oauth"`
  (`{"type":"oauth","access":…,"refresh":…,"expires":…}` plus arbitrary
  provider-specific fields, carried verbatim).

## Delivery event — kind 30990

Parameterized replaceable, owner-authored.

- `d` tag: `"<agent-pubkey-hex>:<provider-id>"` — the agent component MUST be
  64 lowercase hex chars and MUST equal the `p` tag. Deterministic per
  `(agent, provider)`, so re-delivery and revocation replace in place.
- `p` tag: exactly one — the recipient agent's pubkey.
- No `h` tag: deliveries are never channel-scoped.
- `content`: NIP-44 v2 ciphertext (owner key → agent pubkey) of:

```json
{
  "v": 1,
  "provider": "anthropic",
  "credential": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1800000000000 }
}
```

Revocation replaces the coordinate with `{"v":1,"provider":…,"revoked":true}`
(no `credential`). Exactly one of `credential` / `revoked: true` MUST be
present, and `payload.provider` MUST equal the `d` tag's provider component.

### Relay behavior (30990)

- **Write gate**: reject unless the event author is the registered owner of
  the `p`-tagged agent (`restricted:`). Envelope violations are `invalid:`.
- **Read gate**: a REQ/COUNT filter that can match kind 30990 MUST carry
  either `authors` = exactly the reader's pubkey (owner reconciliation) or
  `#p` = exactly the reader's pubkey (agent fetch). Filters that explicitly
  name the kind get no `ids` exemption; kindless `ids` lookups are answered
  but each event is delivered only to its author or `p`-tagged recipient.
- **Search**: stored events MUST be excluded from full-text search (NULL
  `search_tsv`).

### Harness behavior

On connect the agent subscribes with
`{"kinds":[30990],"#p":[self],"authors":[owner]}` — the stored heads arrive
first (current state; no `since` watermark is needed for addressable kinds),
then live updates. For each event: verify the signature, verify the author is
the agent's owner, decrypt, and apply iff the event's `created_at` is newer
than the last applied delivery for that provider (idempotent under
re-delivery). Apply means merging the credential object verbatim into the
host-side credential store; `revoked` removes the entry. Credentials MUST
never enter an execution sandbox or be logged.

## Status event — kind 30991

Parameterized replaceable, agent-authored, deliberately plaintext and
member-readable — it is the owner-facing health signal.

- `d` tag: the provider id.
- No `h` tag.
- `content`: JSON object, at most 4096 bytes:

```json
{ "v": 1, "provider": "anthropic", "state": "applied", "updatedAt": 1754800000 }
```

`state` is `applied`, `removed`, or `error` (unrecognized values MUST be
treated as unknown). `detail`, when present, is a short error class and MUST
NOT contain secret material or provider account identifiers.

### Relay behavior (30991)

Reject unless the author is a registered agent (non-NULL
`users.agent_owner_pubkey`). Envelope violations are `invalid:`.

## Security considerations

- The public envelope of a delivery leaks that an owner configured *some*
  credential for an agent and which provider — the read gate exists so third
  parties cannot enumerate even that.
- The relay stores ciphertext decryptable only by the agent (or owner). Blast
  radius on relay compromise is the ciphertext plus the envelope metadata.
- OAuth refresh-token rotation is single-chain: after delivery, exactly one
  side (the host store) refreshes. Owners re-run the provider sign-in when a
  chain breaks rather than syncing rotated secrets upward.
- Clients SHOULD treat `detail` fields in status events as untrusted display
  text.

## Reference implementation

`buzz-core/src/provider_credential.rs` (payload types, coordinate derivation,
encrypt/decrypt), `buzz-sdk` `build_agent_provider_credential` /
`build_agent_provider_credential_status`, relay gates in
`buzz-relay/src/handlers/ingest.rs` and `req.rs`, FTS exclusion in migration
`0029_provider_credential_fts.sql`.
