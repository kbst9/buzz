//! Optional local config: `~/.config/buzz-backend-ssh/config.toml`.
//!
//! The provider works with no config at all — every field can be typed into the
//! "Run on" form in Desktop. The file exists so the form can arrive *pre-filled*
//! with sensible defaults and a description listing the runtimes actually
//! installed on the host, which matters because Desktop renders provider config
//! as plain text inputs (no dropdowns).

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// SSH alias pre-filled into the `host` field. Must be resolvable from
    /// `~/.ssh/config` — credentials are never accepted through provider config
    /// (Desktop rejects any config key that looks like a secret).
    pub default_host: Option<String>,
    /// Remote Unix user pre-filled into the `user` field. Defaults to the SSH
    /// login user when unset.
    pub default_user: Option<String>,
    /// Base directory for agent working directories; the agent id is appended.
    pub workdir_base: Option<String>,
    /// systemd unit name prefix. Keep the default unless it collides.
    pub unit_prefix: Option<String>,
    /// Seconds to trust a cached runtime probe. `op:info` has a 10s budget in
    /// Desktop, so probing every invocation would risk timing out on a slow link.
    pub probe_cache_seconds: Option<u64>,
}

pub fn config_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/buzz-backend-ssh"))
}

pub fn config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("config.toml"))
}

pub fn cache_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache/buzz-backend-ssh"))
}

/// Load config, tolerating absence. A malformed file is reported rather than
/// silently ignored — a typo in `default_host` that quietly does nothing is
/// worse than a visible error in the Desktop probe result.
pub fn load() -> Result<Config, String> {
    let Some(path) = config_path() else {
        return Ok(Config::default());
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).map_err(|e| format!("invalid {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Write a commented example config if none exists. Best-effort: a failure here
/// must never fail an `op:info`.
pub fn write_example_if_missing() {
    let (Some(dir), Some(path)) = (config_dir(), config_path()) else {
        return;
    };
    if path.exists() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(
        &path,
        "# buzz-backend-ssh — optional defaults for the \"Run on\" form.\n\
         # Credentials are never configured here: the host must be an alias in\n\
         # ~/.ssh/config, and authentication uses your SSH agent.\n\
         \n\
         # default_host = \"my-server\"\n\
         # default_user = \"buzz\"\n\
         # workdir_base = \"/home/buzz/agents\"\n\
         # unit_prefix = \"buzz-acp-\"\n\
         # probe_cache_seconds = 600\n",
    );
}

impl Config {
    pub fn unit_prefix(&self) -> String {
        self.unit_prefix
            .clone()
            .unwrap_or_else(|| "buzz-acp-".to_string())
    }
    pub fn probe_cache_seconds(&self) -> u64 {
        self.probe_cache_seconds.unwrap_or(600)
    }
}
