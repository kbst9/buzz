//! NIP-PC credential sink — receives `kind:30990` provider credential
//! deliveries addressed to this agent, materializes them into the host
//! credential store, and derives child-process env for API-key credentials.
//!
//! # Store
//!
//! `<workspace>/credentials.json`, mode 0600, atomic tmp+rename writes:
//!
//! ```json
//! {
//!   "version": 1,
//!   "providers": {
//!     "anthropic": {
//!       "credential": { "type": "oauth", "access": "…", "refresh": "…", "expires": 0 },
//!       "deliveredCreatedAt": 1754800000,
//!       "updatedAt": 1754800000
//!     }
//!   }
//! }
//! ```
//!
//! `credential` is the pi-style credential object carried verbatim from the
//! delivery payload. `deliveredCreatedAt` is the delivery event's
//! `created_at` and is the idempotency guard: a delivery applies only if
//! strictly newer than what is stored (re-delivered addressable heads are
//! no-ops).
//!
//! # Cross-process lock protocol (shared contract with flue-host)
//!
//! Writers coordinate through a sidecar lockfile `credentials.json.lock`,
//! created with `O_CREAT|O_EXCL` (there is no portable flock from Node, so
//! the protocol is create-exclusive + stale takeover, implemented identically
//! in `flue-host/src/engine/credential-store.ts`):
//!
//! - acquire: try exclusive-create; on success write the holder pid.
//! - contended: if the lockfile's mtime is older than 30s, remove it (crash
//!   takeover) and retry immediately; otherwise sleep 25ms and retry.
//! - acquire times out after 5s; release removes the file.
//!
//! All waiting is blocking — callers in async context run the apply inside
//! `tokio::task::spawn_blocking`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nostr::{Event, Keys};
use serde::{Deserialize, Serialize};

use buzz_core::provider_credential::{
    decrypt_provider_credential, parse_provider_credential_d_tag,
};

/// File name of the credential store inside the workspace.
pub(crate) const STORE_FILE: &str = "credentials.json";
/// Store schema version.
const STORE_VERSION: u32 = 1;
/// Lockfile staleness threshold (crash takeover).
const LOCK_STALE: Duration = Duration::from_secs(30);
/// Lock acquisition retry interval.
const LOCK_RETRY: Duration = Duration::from_millis(25);
/// Lock acquisition timeout.
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Providers whose stored `api_key` credentials are projected into agent
/// subprocess env (absent-only — operator env always wins in
/// `AcpClient::spawn`). OAuth credentials are deliberately NOT projected:
/// they rotate, and their consumer is the flue-host store reader.
const API_KEY_ENV_MAP: &[(&str, &str)] = &[
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("cursor", "CURSOR_API_KEY"),
];

/// One provider's entry in the store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreEntry {
    /// pi-style credential object, verbatim from the delivery payload. The
    /// flue-host store reader may rewrite this in place on OAuth refresh.
    pub credential: serde_json::Value,
    /// `created_at` of the applied delivery event (idempotency guard).
    pub delivered_created_at: u64,
    /// Unix seconds of the last local write.
    pub updated_at: u64,
    /// Forward compatibility: preserve fields written by newer readers.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// The on-disk store document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreFile {
    pub version: u32,
    /// Keyed by provider id. BTreeMap for deterministic serialization.
    #[serde(default)]
    pub providers: BTreeMap<String, StoreEntry>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for StoreFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            providers: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

/// Result of applying one delivery event to the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ApplyOutcome {
    /// Credential written (new or rotated).
    Applied { provider: String },
    /// Revocation applied — the provider's entry was removed (or was absent).
    Removed { provider: String },
    /// Delivery is not newer than the stored entry — no-op. Expected on every
    /// resubscribe, since addressable heads re-arrive.
    Stale { provider: String },
}

/// Sink failure. `provider` is carried where known so the caller can publish
/// a `kind:30991` error status for the right coordinate.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SinkError {
    #[error("event verification failed: {0}")]
    Verification(String),
    #[error("envelope rejected: {0}")]
    Envelope(String),
    #[error("payload rejected for {provider}: {message}")]
    Payload { provider: String, message: String },
    #[error("store io for {provider}: {message}")]
    StoreIo { provider: String, message: String },
}

impl SinkError {
    /// The provider coordinate to report status against, when known.
    pub(crate) fn provider(&self) -> Option<&str> {
        match self {
            SinkError::Verification(_) | SinkError::Envelope(_) => None,
            SinkError::Payload { provider, .. } | SinkError::StoreIo { provider, .. } => {
                Some(provider)
            }
        }
    }
}

/// Absolute path of the credential store for a workspace.
pub(crate) fn store_path(workspace: &Path) -> PathBuf {
    workspace.join(STORE_FILE)
}

/// Resolve the workspace directory for the credential store, mirroring
/// `workspace::prepare`'s resolution (explicit config → cwd nest marker →
/// default nest). `prepare` chdirs into the seeded workspace at startup, so
/// the cwd-marker arm hits for the normal case.
pub(crate) fn resolve_store_workspace(configured: Option<&str>) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok();
    crate::workspace::resolve_workspace(configured, cwd.as_deref(), buzz_nest::default_nest_dir())
}

/// Held write lock on the store. Released (best-effort) on drop.
#[derive(Debug)]
struct StoreLock {
    path: PathBuf,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Acquire the cross-process store lock. Blocking — see module docs.
fn acquire_lock(store: &Path, stale: Duration, timeout: Duration) -> Result<StoreLock, String> {
    let lock_path = {
        let mut name = store.file_name().unwrap_or_default().to_os_string();
        name.push(".lock");
        store.with_file_name(name)
    };
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create store dir: {e}"))?;
    }
    let deadline = Instant::now() + timeout;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                use std::io::Write as _;
                let _ = write!(file, "{}", std::process::id());
                return Ok(StoreLock { path: lock_path });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let is_stale = std::fs::metadata(&lock_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|mtime| SystemTime::now().duration_since(mtime).ok())
                    .is_some_and(|age| age > stale);
                if is_stale {
                    // Crash takeover — removal races are fine: the loser's
                    // create_new simply fails and it retries.
                    let _ = std::fs::remove_file(&lock_path);
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "timed out acquiring {} after {:?}",
                        lock_path.display(),
                        timeout
                    ));
                }
                std::thread::sleep(LOCK_RETRY);
            }
            Err(e) => return Err(format!("open {}: {e}", lock_path.display())),
        }
    }
}

/// Load the store, treating a missing file as empty. A corrupt store is an
/// error, NOT an empty store — silently replacing it could clobber rotated
/// OAuth state written by a newer flue-host.
fn load_store(path: &Path) -> Result<StoreFile, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("parse store: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StoreFile::default()),
        Err(e) => Err(format!("read store: {e}")),
    }
}

/// Atomically write `store` to `path` with mode 0600 (tmp file in the same
/// directory + rename).
fn write_store(path: &Path, store: &StoreFile) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| format!("serialize store: {e}"))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        use std::io::Write as _;
        let mut file = options
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(&bytes)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })
}

/// Unix seconds now.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Verify, decrypt, and apply one `kind:30990` delivery to the store.
///
/// Security order mirrors `handle_relay_observer_control_event`: signature →
/// sender-is-owner → envelope binding → decrypt → apply. Blocking (lock +
/// file IO) — run inside `spawn_blocking` from async context.
pub(crate) fn apply_delivery(
    workspace: &Path,
    agent_keys: &Keys,
    owner_pubkey_hex: &str,
    event: &Event,
) -> Result<ApplyOutcome, SinkError> {
    buzz_core::verify_event(event).map_err(|e| SinkError::Verification(e.to_string()))?;

    let kind = buzz_core::kind::event_kind_u32(event);
    if kind != buzz_core::kind::KIND_AGENT_PROVIDER_CREDENTIAL {
        return Err(SinkError::Envelope(format!(
            "unexpected kind {kind} on credential subscription"
        )));
    }

    // Sender MUST be the resolved owner. The relay's write gate enforces the
    // registered-owner mapping; this check keeps the sink safe even against a
    // misbehaving relay.
    if !event.pubkey.to_hex().eq_ignore_ascii_case(owner_pubkey_hex) {
        return Err(SinkError::Envelope(format!(
            "author {} is not the resolved owner",
            event.pubkey.to_hex()
        )));
    }

    // Envelope binding: single d tag `<self>:<provider>`, p tag == self.
    let self_hex = agent_keys.public_key().to_hex();
    let mut d_value: Option<String> = None;
    let mut p_matches_self = false;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        match parts.first().map(|s| s.as_str()) {
            Some("d") => d_value = parts.get(1).map(|s| s.to_string()),
            Some("p") if parts.get(1).map(|s| s.as_str()) == Some(self_hex.as_str()) => {
                p_matches_self = true;
            }
            _ => {}
        }
    }
    let Some(d) = d_value else {
        return Err(SinkError::Envelope("missing d tag".into()));
    };
    let Some((d_agent, d_provider)) = parse_provider_credential_d_tag(&d) else {
        return Err(SinkError::Envelope(format!("malformed d tag {d:?}")));
    };
    if d_agent != self_hex {
        return Err(SinkError::Envelope(
            "d tag addresses a different agent".into(),
        ));
    }
    if !p_matches_self {
        return Err(SinkError::Envelope("p tag does not name this agent".into()));
    }
    let provider = d_provider.to_string();

    // Decrypt fail-closed; bind payload.provider to the coordinate.
    let payload =
        decrypt_provider_credential(agent_keys, event).map_err(|e| SinkError::Payload {
            provider: provider.clone(),
            message: e.to_string(),
        })?;
    if payload.provider != provider {
        return Err(SinkError::Payload {
            provider,
            message: format!(
                "payload provider {:?} does not match coordinate",
                payload.provider
            ),
        });
    }

    let path = store_path(workspace);
    let io_err = |message: String| SinkError::StoreIo {
        provider: provider.clone(),
        message,
    };
    let _lock = acquire_lock(&path, LOCK_STALE, LOCK_TIMEOUT).map_err(io_err)?;
    let mut store = load_store(&path).map_err(io_err)?;

    let created_at = event.created_at.as_secs();
    if let Some(existing) = store.providers.get(&provider) {
        if existing.delivered_created_at >= created_at {
            return Ok(ApplyOutcome::Stale { provider });
        }
    }

    let outcome = if payload.revoked {
        store.providers.remove(&provider);
        ApplyOutcome::Removed {
            provider: provider.clone(),
        }
    } else {
        // validate() guarantees credential presence when !revoked.
        let Some(credential) = payload.credential else {
            return Err(SinkError::Payload {
                provider,
                message: "non-revoked payload without credential".into(),
            });
        };
        store.providers.insert(
            provider.clone(),
            StoreEntry {
                credential,
                delivered_created_at: created_at,
                updated_at: unix_now(),
                extra: BTreeMap::new(),
            },
        );
        ApplyOutcome::Applied {
            provider: provider.clone(),
        }
    };

    write_store(&path, &store).map_err(|message| SinkError::StoreIo {
        provider: match &outcome {
            ApplyOutcome::Applied { provider }
            | ApplyOutcome::Removed { provider }
            | ApplyOutcome::Stale { provider } => provider.clone(),
        },
        message,
    })?;
    Ok(outcome)
}

/// Env pairs derived from stored `api_key` credentials, for injection into
/// agent subprocesses. Read-only (atomic renames make plain reads safe);
/// unknown providers and OAuth entries are skipped. Errors degrade to empty —
/// spawn must never fail because the store is unreadable.
pub(crate) fn api_key_env_pairs(workspace: &Path) -> Vec<(String, String)> {
    let store = match load_store(&store_path(workspace)) {
        Ok(store) => store,
        Err(e) => {
            tracing::warn!(target: "credential_sink", "store unreadable for env projection: {e}");
            return Vec::new();
        }
    };
    let mut pairs = Vec::new();
    for (provider, entry) in &store.providers {
        let Some(env_key) = API_KEY_ENV_MAP
            .iter()
            .find(|(p, _)| p == provider)
            .map(|(_, k)| *k)
        else {
            continue;
        };
        let is_api_key = entry.credential.get("type").and_then(|t| t.as_str()) == Some("api_key");
        let Some(key) = entry.credential.get("key").and_then(|k| k.as_str()) else {
            continue;
        };
        if is_api_key && !key.is_empty() {
            pairs.push((env_key.to_string(), key.to_string()));
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::provider_credential::{
        encrypt_provider_credential, provider_credential_d_tag, ProviderCredentialPayload,
    };
    use nostr::{EventBuilder, Kind, Tag};
    use serde_json::json;

    fn delivery_event(
        owner: &Keys,
        agent: &Keys,
        provider: &str,
        credential: Option<serde_json::Value>,
        revoked: bool,
        created_at: u64,
    ) -> Event {
        let payload = ProviderCredentialPayload {
            v: 1,
            provider: provider.to_string(),
            credential,
            revoked,
        };
        let ciphertext =
            encrypt_provider_credential(owner, &agent.public_key(), &payload).expect("encrypt");
        let agent_hex = agent.public_key().to_hex();
        EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_AGENT_PROVIDER_CREDENTIAL as u16),
            ciphertext,
        )
        .tags([
            Tag::parse(["d", &provider_credential_d_tag(&agent_hex, provider)]).unwrap(),
            Tag::parse(["p", &agent_hex]).unwrap(),
        ])
        .custom_created_at(nostr::Timestamp::from(created_at))
        .sign_with_keys(owner)
        .expect("sign")
    }

    fn api_key_value(key: &str) -> serde_json::Value {
        json!({"type": "api_key", "key": key})
    }

    #[test]
    fn apply_then_rotate_then_revoke() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let owner_hex = owner.public_key().to_hex();

        // Apply.
        let ev = delivery_event(&owner, &agent, "xai", Some(api_key_value("k1")), false, 100);
        let outcome = apply_delivery(dir.path(), &agent, &owner_hex, &ev).expect("apply");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied {
                provider: "xai".into()
            }
        );
        let store = load_store(&store_path(dir.path())).unwrap();
        assert_eq!(
            store.providers["xai"].credential["key"].as_str(),
            Some("k1")
        );
        assert_eq!(store.providers["xai"].delivered_created_at, 100);

        // Rotate (newer created_at replaces).
        let ev = delivery_event(&owner, &agent, "xai", Some(api_key_value("k2")), false, 200);
        let outcome = apply_delivery(dir.path(), &agent, &owner_hex, &ev).expect("rotate");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied {
                provider: "xai".into()
            }
        );
        let store = load_store(&store_path(dir.path())).unwrap();
        assert_eq!(
            store.providers["xai"].credential["key"].as_str(),
            Some("k2")
        );

        // Revoke.
        let ev = delivery_event(&owner, &agent, "xai", None, true, 300);
        let outcome = apply_delivery(dir.path(), &agent, &owner_hex, &ev).expect("revoke");
        assert_eq!(
            outcome,
            ApplyOutcome::Removed {
                provider: "xai".into()
            }
        );
        let store = load_store(&store_path(dir.path())).unwrap();
        assert!(store.providers.is_empty());
    }

    #[test]
    fn stale_delivery_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let owner_hex = owner.public_key().to_hex();

        let ev = delivery_event(&owner, &agent, "xai", Some(api_key_value("k2")), false, 200);
        apply_delivery(dir.path(), &agent, &owner_hex, &ev).expect("apply");

        // Same timestamp (the re-arriving addressable head) and older both skip.
        for ts in [200, 150] {
            let ev = delivery_event(&owner, &agent, "xai", Some(api_key_value("old")), false, ts);
            let outcome = apply_delivery(dir.path(), &agent, &owner_hex, &ev).expect("stale");
            assert_eq!(
                outcome,
                ApplyOutcome::Stale {
                    provider: "xai".into()
                }
            );
        }
        let store = load_store(&store_path(dir.path())).unwrap();
        assert_eq!(
            store.providers["xai"].credential["key"].as_str(),
            Some("k2"),
            "stale delivery must not overwrite"
        );
    }

    #[test]
    fn rejects_wrong_owner_and_wrong_recipient() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let impostor = Keys::generate();
        let agent = Keys::generate();
        let other_agent = Keys::generate();
        let owner_hex = owner.public_key().to_hex();

        // Signed by an impostor: sender-is-owner check fires.
        let ev = delivery_event(
            &impostor,
            &agent,
            "xai",
            Some(api_key_value("k")),
            false,
            100,
        );
        let err = apply_delivery(dir.path(), &agent, &owner_hex, &ev).unwrap_err();
        assert!(matches!(err, SinkError::Envelope(_)), "got {err:?}");

        // Addressed to a different agent: envelope binding fires (and decrypt
        // would fail anyway — fail-closed either way).
        let ev = delivery_event(
            &owner,
            &other_agent,
            "xai",
            Some(api_key_value("k")),
            false,
            100,
        );
        let err = apply_delivery(dir.path(), &agent, &owner_hex, &ev).unwrap_err();
        assert!(matches!(err, SinkError::Envelope(_)), "got {err:?}");

        assert!(
            !store_path(dir.path()).exists(),
            "rejected deliveries must not create a store"
        );
    }

    #[test]
    fn undecryptable_payload_fails_closed_with_provider() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        let agent_hex = agent.public_key().to_hex();

        // Well-formed envelope, but ciphertext for a DIFFERENT recipient.
        let stranger = Keys::generate();
        let payload = ProviderCredentialPayload {
            v: 1,
            provider: "anthropic".into(),
            credential: Some(api_key_value("k")),
            revoked: false,
        };
        let ciphertext =
            encrypt_provider_credential(&owner, &stranger.public_key(), &payload).unwrap();
        let ev = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_AGENT_PROVIDER_CREDENTIAL as u16),
            ciphertext,
        )
        .tags([
            Tag::parse(["d", &provider_credential_d_tag(&agent_hex, "anthropic")]).unwrap(),
            Tag::parse(["p", &agent_hex]).unwrap(),
        ])
        .sign_with_keys(&owner)
        .unwrap();

        let err = apply_delivery(dir.path(), &agent, &owner_hex, &ev).unwrap_err();
        match err {
            SinkError::Payload { ref provider, .. } => assert_eq!(provider, "anthropic"),
            other => panic!("expected Payload error, got {other:?}"),
        }
    }

    #[test]
    fn corrupt_store_is_an_error_not_a_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let owner_hex = owner.public_key().to_hex();
        std::fs::write(store_path(dir.path()), b"{not json").unwrap();

        let ev = delivery_event(&owner, &agent, "xai", Some(api_key_value("k")), false, 100);
        let err = apply_delivery(dir.path(), &agent, &owner_hex, &ev).unwrap_err();
        assert!(matches!(err, SinkError::StoreIo { .. }), "got {err:?}");
        assert_eq!(
            std::fs::read(store_path(dir.path())).unwrap(),
            b"{not json",
            "corrupt store must be left untouched"
        );
    }

    #[test]
    fn lock_contention_and_stale_takeover() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join(STORE_FILE);

        // Held fresh lock: acquisition times out.
        let held = acquire_lock(&store, Duration::from_secs(30), Duration::from_secs(1))
            .expect("first acquire");
        let err = acquire_lock(&store, Duration::from_secs(30), Duration::from_millis(120))
            .expect_err("second acquire must time out");
        assert!(err.contains("timed out"), "got: {err}");
        drop(held);

        // Released: acquire succeeds again.
        let held = acquire_lock(&store, Duration::from_secs(30), Duration::from_secs(1))
            .expect("re-acquire after release");
        drop(held);

        // Stale lock (threshold zero => immediately stale): takeover succeeds.
        std::fs::write(store.with_file_name("credentials.json.lock"), b"999999").unwrap();
        let held =
            acquire_lock(&store, Duration::ZERO, Duration::from_secs(1)).expect("stale takeover");
        drop(held);
    }

    #[test]
    fn env_projection_only_api_keys_for_known_providers() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let agent = Keys::generate();
        let owner_hex = owner.public_key().to_hex();

        for (provider, credential, ts) in [
            ("xai", api_key_value("xai-key"), 100),
            (
                "anthropic",
                json!({"type": "oauth", "access": "a", "refresh": "r", "expires": 1}),
                101,
            ),
            ("unknown-provider", api_key_value("nope"), 102),
        ] {
            let ev = delivery_event(&owner, &agent, provider, Some(credential), false, ts);
            apply_delivery(dir.path(), &agent, &owner_hex, &ev).expect("apply");
        }

        let pairs = api_key_env_pairs(dir.path());
        assert_eq!(
            pairs,
            vec![("XAI_API_KEY".to_string(), "xai-key".to_string())]
        );

        // Missing store: empty, never an error.
        let empty = tempfile::tempdir().unwrap();
        assert!(api_key_env_pairs(empty.path()).is_empty());
    }
}
