//! Desired-state store.
//!
//! One JSON file (`agents.json`) holds every hosted agent's configuration
//! and lifecycle intent; per-agent secret keys live in separate `0600`
//! files under `keys/`, never inside the JSON. The supervisor reconciles
//! running children against this store on startup, so a daemon restart
//! restores every granted, running agent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use buzz_core::host::HostAgentConfig;
use nostr::Keys;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::HostError;

/// One hosted agent's desired state. Never contains key material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentRecord {
    /// Agent pubkey (hex) — the supervision identity.
    pub pubkey: String,
    /// Owner pubkey (hex) — the `create` sender; the only pubkey allowed
    /// to mutate this agent.
    pub owner: String,
    /// Agent configuration (rendered into the harness env).
    pub config: HostAgentConfig,
    /// NIP-OA auth tag JSON delivered by `grant`; `None` until granted.
    /// Not secret — it appears in every event the agent publishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_tag: Option<String>,
    /// Whether the agent should be running (false after `stop`).
    pub desired_run: bool,
    /// Unix timestamp of record creation.
    pub created_at: u64,
}

/// Disk-backed store of [`AgentRecord`]s plus per-agent key files.
pub struct StateStore {
    state_dir: PathBuf,
    agents: BTreeMap<String, AgentRecord>,
}

impl StateStore {
    /// Open (or initialize) the store under `state_dir`.
    pub fn open(state_dir: &Path) -> Result<Self, HostError> {
        std::fs::create_dir_all(state_dir.join("keys"))
            .map_err(|e| HostError::State(format!("create state dir: {e}")))?;
        std::fs::create_dir_all(state_dir.join("logs"))
            .map_err(|e| HostError::State(format!("create logs dir: {e}")))?;
        let agents_path = state_dir.join("agents.json");
        let agents = if agents_path.exists() {
            let raw = std::fs::read_to_string(&agents_path)
                .map_err(|e| HostError::State(format!("read agents.json: {e}")))?;
            serde_json::from_str::<Vec<AgentRecord>>(&raw)
                .map_err(|e| HostError::State(format!("parse agents.json: {e}")))?
                .into_iter()
                .map(|r| (r.pubkey.clone(), r))
                .collect()
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            agents,
        })
    }

    /// All records, ordered by pubkey.
    pub fn agents(&self) -> impl Iterator<Item = &AgentRecord> {
        self.agents.values()
    }

    /// Number of records.
    pub fn len(&self) -> usize {
        self.agents.len()
    }

    /// True when the store holds no agents.
    pub fn is_empty(&self) -> bool {
        self.agents.is_empty()
    }

    /// Records owned by `owner` (hex pubkey).
    pub fn agents_owned_by<'a>(&'a self, owner: &'a str) -> impl Iterator<Item = &'a AgentRecord> {
        self.agents.values().filter(move |r| r.owner == owner)
    }

    /// Look up one record.
    pub fn get(&self, pubkey: &str) -> Option<&AgentRecord> {
        self.agents.get(pubkey)
    }

    /// Insert or replace a record and persist.
    pub fn upsert(&mut self, record: AgentRecord) -> Result<(), HostError> {
        self.agents.insert(record.pubkey.clone(), record);
        self.persist()
    }

    /// Remove a record, its key file, and its log file; persist.
    pub fn remove(&mut self, pubkey: &str) -> Result<(), HostError> {
        self.agents.remove(pubkey);
        let key_path = self.key_path(pubkey);
        if key_path.exists() {
            std::fs::remove_file(&key_path)
                .map_err(|e| HostError::State(format!("remove key file: {e}")))?;
        }
        let log_path = self.log_path(pubkey);
        if log_path.exists() {
            let _ = std::fs::remove_file(&log_path);
        }
        self.persist()
    }

    /// Generate a fresh agent keypair, write the secret to a `0600` key
    /// file, and return the keys. The secret never enters `agents.json`.
    pub fn generate_agent_keys(&self, pubkey_hint: Option<&str>) -> Result<Keys, HostError> {
        let _ = pubkey_hint;
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let mut nsec = keys.secret_key().to_secret_hex();
        let path = self.key_path(&pubkey);
        write_secret_file(&path, &nsec)?;
        nsec.zeroize();
        Ok(keys)
    }

    /// Load an agent's secret key from its key file.
    pub fn load_agent_secret(&self, pubkey: &str) -> Result<String, HostError> {
        let path = self.key_path(pubkey);
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| HostError::State(format!("read key file for {pubkey}: {e}")))?;
        Ok(raw.trim().to_string())
    }

    /// Path of an agent's log file.
    pub fn log_path(&self, pubkey: &str) -> PathBuf {
        // Pubkeys are validated hex, so they are safe as file names.
        self.state_dir.join("logs").join(format!("{pubkey}.log"))
    }

    fn key_path(&self, pubkey: &str) -> PathBuf {
        self.state_dir.join("keys").join(format!("{pubkey}.key"))
    }

    fn persist(&self) -> Result<(), HostError> {
        let records: Vec<&AgentRecord> = self.agents.values().collect();
        let json = serde_json::to_string_pretty(&records)
            .map_err(|e| HostError::State(format!("serialize agents.json: {e}")))?;
        let path = self.state_dir.join("agents.json");
        let tmp = self.state_dir.join("agents.json.tmp");
        std::fs::write(&tmp, &json)
            .map_err(|e| HostError::State(format!("write agents.json.tmp: {e}")))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| HostError::State(format!("swap agents.json: {e}")))?;
        Ok(())
    }
}

/// Load (or generate on first run) the daemon's own identity key.
pub fn load_or_generate_daemon_keys(state_dir: &Path) -> Result<Keys, HostError> {
    let path = state_dir.join("daemon.key");
    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| HostError::State(format!("read daemon.key: {e}")))?;
        let keys = Keys::parse(raw.trim())
            .map_err(|e| HostError::State(format!("parse daemon.key: {e}")))?;
        return Ok(keys);
    }
    std::fs::create_dir_all(state_dir)
        .map_err(|e| HostError::State(format!("create state dir: {e}")))?;
    let keys = Keys::generate();
    let mut nsec = keys.secret_key().to_secret_hex();
    write_secret_file(&path, &nsec)?;
    nsec.zeroize();
    Ok(keys)
}

fn write_secret_file(path: &Path, contents: &str) -> Result<(), HostError> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| HostError::State(format!("create secret file {}: {e}", path.display())))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| HostError::State(format!("write secret file: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(pubkey: &str, owner: &str) -> AgentRecord {
        AgentRecord {
            pubkey: pubkey.into(),
            owner: owner.into(),
            config: HostAgentConfig {
                label: "researcher".into(),
                runtime: "claude".into(),
                system_prompt: Some("be thorough".into()),
                model: None,
                provider: None,
                env: BTreeMap::new(),
            },
            auth_tag: None,
            desired_run: false,
            created_at: 1_753_000_000,
        }
    }

    #[test]
    fn round_trips_records_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = StateStore::open(dir.path()).unwrap();
        store.upsert(record("aa", "bb")).unwrap();
        store.upsert(record("cc", "bb")).unwrap();

        let store2 = StateStore::open(dir.path()).unwrap();
        assert_eq!(store2.len(), 2);
        assert_eq!(store2.get("aa").unwrap().owner, "bb");
    }

    #[test]
    fn remove_deletes_record_and_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = StateStore::open(dir.path()).unwrap();
        let keys = store.generate_agent_keys(None).unwrap();
        let pubkey = keys.public_key().to_hex();
        store.upsert(record(&pubkey, "bb")).unwrap();
        assert!(store.load_agent_secret(&pubkey).is_ok());

        store.remove(&pubkey).unwrap();
        assert!(store.get(&pubkey).is_none());
        assert!(store.load_agent_secret(&pubkey).is_err());
    }

    #[test]
    fn generated_secret_round_trips_to_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::open(dir.path()).unwrap();
        let keys = store.generate_agent_keys(None).unwrap();
        let secret = store
            .load_agent_secret(&keys.public_key().to_hex())
            .unwrap();
        let restored = Keys::parse(&secret).unwrap();
        assert_eq!(restored.public_key(), keys.public_key());
    }

    #[cfg(unix)]
    #[test]
    fn secret_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::open(dir.path()).unwrap();
        let keys = store.generate_agent_keys(None).unwrap();
        let path = dir
            .path()
            .join("keys")
            .join(format!("{}.key", keys.public_key().to_hex()));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn agents_json_never_contains_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = StateStore::open(dir.path()).unwrap();
        let keys = store.generate_agent_keys(None).unwrap();
        let pubkey = keys.public_key().to_hex();
        store.upsert(record(&pubkey, "bb")).unwrap();

        let json = std::fs::read_to_string(dir.path().join("agents.json")).unwrap();
        let secret = store.load_agent_secret(&pubkey).unwrap();
        assert!(!json.contains(&secret));
        assert!(!json.contains("nsec"));
    }
}
