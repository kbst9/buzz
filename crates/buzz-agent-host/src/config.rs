//! Daemon configuration.
//!
//! Loaded from a TOML file (default `/etc/buzz-agent-host/config.toml`,
//! overridable via `--config` / `BUZZ_HOST_CONFIG`). The runtime table is
//! the host's capability boundary: control frames name a runtime `id`, and
//! only ids present here can ever be launched. Command lines never appear
//! on the wire.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::HostError;

/// Top-level daemon configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostConfig {
    /// Stable host id — becomes the announcement `d` tag. `[a-z0-9_-]`.
    pub host_id: String,
    /// Human-readable label shown in Desktop's host picker.
    pub label: String,
    /// Relay WebSocket URL, e.g. `ws://localhost:3000`.
    pub relay_url: String,
    /// Directory holding the daemon key, desired state, agent keys, and logs.
    pub state_dir: PathBuf,
    /// Launchable runtimes, keyed by the id advertised in the announcement.
    pub runtimes: BTreeMap<String, RuntimeSpec>,
    /// Acceptance policy.
    #[serde(default)]
    pub policy: HostPolicy,
}

/// One launchable runtime: how a runtime id maps to a harness command.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSpec {
    /// Human-readable label shown in Desktop's runtime dropdown.
    pub label: String,
    /// Absolute path to the `buzz-acp` binary to supervise.
    pub harness: PathBuf,
    /// Value for `BUZZ_ACP_AGENT_COMMAND` (the ACP agent the harness spawns).
    pub agent_command: String,
    /// Value for `BUZZ_ACP_AGENT_ARGS` (comma-separated, may be empty).
    #[serde(default)]
    pub agent_args: String,
    /// Extra environment applied to every agent on this runtime. Loses to
    /// both per-agent config env and the daemon-reserved variables.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// Host acceptance policy.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct HostPolicy {
    /// If non-empty, only these hex pubkeys may send control requests.
    /// Empty means any current community member.
    #[serde(default)]
    pub allowlist: Vec<String>,
    /// Maximum agents in the desired-state store (0 = default 32).
    #[serde(default)]
    pub max_agents: u32,
    /// Maximum agents per owner (0 = unlimited).
    #[serde(default)]
    pub max_agents_per_owner: u32,
}

impl HostPolicy {
    /// Effective max agents (default 32).
    pub fn effective_max_agents(&self) -> u32 {
        if self.max_agents == 0 {
            32
        } else {
            self.max_agents
        }
    }
}

impl HostConfig {
    /// Load and validate a config file.
    pub fn load(path: &Path) -> Result<Self, HostError> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| HostError::Config(format!("cannot read {}: {e}", path.display())))?;
        let config: HostConfig = toml::from_str(&raw)
            .map_err(|e| HostError::Config(format!("cannot parse {}: {e}", path.display())))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), HostError> {
        if self.host_id.is_empty()
            || self.host_id.len() > 64
            || !self
                .host_id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        {
            return Err(HostError::Config(
                "host_id must be 1–64 chars of [a-z0-9_-]".into(),
            ));
        }
        if self.runtimes.is_empty() {
            return Err(HostError::Config(
                "at least one [runtimes.<id>] entry is required".into(),
            ));
        }
        for (id, spec) in &self.runtimes {
            if id.is_empty()
                || id.len() > 64
                || !id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
            {
                return Err(HostError::Config(format!(
                    "runtime id {id:?} must be 1–64 chars of [a-z0-9_-]"
                )));
            }
            if !spec.harness.is_absolute() {
                return Err(HostError::Config(format!(
                    "runtimes.{id}.harness must be an absolute path"
                )));
            }
        }
        for pubkey in &self.policy.allowlist {
            if nostr::PublicKey::from_hex(pubkey).is_err() {
                return Err(HostError::Config(format!(
                    "policy.allowlist entry {pubkey:?} is not a valid hex pubkey"
                )));
            }
        }
        Ok(())
    }

    /// Announcement content derived from this config.
    pub fn announce_content(
        &self,
        version: &str,
        deployed: u32,
    ) -> buzz_core::host::HostAnnounceContent {
        buzz_core::host::HostAnnounceContent {
            label: self.label.clone(),
            version: version.to_string(),
            runtimes: self
                .runtimes
                .iter()
                .map(|(id, spec)| buzz_core::host::HostRuntime {
                    id: id.clone(),
                    label: spec.label.clone(),
                })
                .collect(),
            capacity: buzz_core::host::HostCapacity {
                max_agents: self.policy.effective_max_agents(),
                deployed,
            },
            accepts_from: if self.policy.allowlist.is_empty() {
                buzz_core::host::HostAcceptsFrom::Members
            } else {
                buzz_core::host::HostAcceptsFrom::Allowlist
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"
host_id = "gradient"
label = "gradient"
relay_url = "ws://localhost:3000"
state_dir = "/var/lib/buzz-agent-host"

[runtimes.claude]
label = "Claude Code"
harness = "/usr/local/bin/buzz-acp"
agent_command = "claude-code-acp"

[policy]
max_agents = 16
"#;

    #[test]
    fn parses_and_validates_good_config() {
        let config: HostConfig = toml::from_str(GOOD).unwrap();
        config.validate().unwrap();
        assert_eq!(config.host_id, "gradient");
        assert_eq!(config.runtimes["claude"].agent_command, "claude-code-acp");
        assert_eq!(config.policy.effective_max_agents(), 16);
    }

    #[test]
    fn rejects_relative_harness_path() {
        let bad = GOOD.replace("/usr/local/bin/buzz-acp", "buzz-acp");
        let config: HostConfig = toml::from_str(&bad).unwrap();
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_bad_host_id() {
        let bad = GOOD.replace("\"gradient\"", "\"Has Space\"");
        let config: HostConfig = toml::from_str(&bad).unwrap();
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_empty_runtimes() {
        let config: Result<HostConfig, _> = toml::from_str(
            r#"
host_id = "x"
label = "x"
relay_url = "ws://localhost:3000"
state_dir = "/tmp/x"
runtimes = {}
"#,
        );
        let config = config.unwrap();
        assert!(config.validate().is_err());
    }

    #[test]
    fn announce_content_reflects_policy() {
        let config: HostConfig = toml::from_str(GOOD).unwrap();
        let content = config.announce_content("0.1.0", 3);
        assert_eq!(content.capacity.deployed, 3);
        assert_eq!(content.capacity.max_agents, 16);
        assert_eq!(
            content.accepts_from,
            buzz_core::host::HostAcceptsFrom::Members
        );
        assert_eq!(content.runtimes.len(), 1);
    }
}
