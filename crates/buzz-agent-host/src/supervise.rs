//! Direct child supervision of `buzz-acp` harness processes.
//!
//! One supervised child per hosted agent, keyed by agent pubkey. No shell
//! is involved anywhere: env is a typed map handed to
//! [`tokio::process::Command::envs`], so there is no quoting or injection
//! surface. Crashed children restart with exponential backoff; a run that
//! stays up long enough resets the backoff.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use buzz_core::host::{HostAgentState, HostAgentStatus};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::{HostConfig, RuntimeSpec};
use crate::state::AgentRecord;
use crate::HostError;

/// Maximum log lines retained in memory per agent.
const LOG_RING_CAP: usize = 2_000;
/// Backoff floor after a crash.
const BACKOFF_MIN: Duration = Duration::from_secs(1);
/// Backoff ceiling.
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A child that stays up this long resets the backoff.
const STABLE_RUN: Duration = Duration::from_secs(300);

/// Env vars owned by the daemon. Per-agent and per-runtime env cannot
/// override these — mirroring Desktop, where harness-definition env loses
/// to Buzz-injected vars.
const RESERVED_ENV: &[&str] = &[
    "BUZZ_PRIVATE_KEY",
    "BUZZ_AUTH_TAG",
    "BUZZ_RELAY_URL",
    "BUZZ_ACP_AGENT_COMMAND",
    "BUZZ_ACP_AGENT_ARGS",
    "BUZZ_ACP_SYSTEM_PROMPT",
    "BUZZ_ACP_MODEL",
    "BUZZ_MANAGED_AGENT",
];

/// Render the full child environment for an agent.
///
/// Precedence (low → high): runtime env → agent config env → reserved
/// daemon-injected vars. Returns an error if the caller-supplied maps try
/// to set a reserved key, so a misconfigured agent fails loudly at spawn
/// rather than silently losing its identity.
pub fn render_env(
    record: &AgentRecord,
    runtime: &RuntimeSpec,
    relay_url: &str,
    agent_secret_hex: &str,
) -> Result<BTreeMap<String, String>, HostError> {
    let mut env = BTreeMap::new();
    for (source, map) in [("runtime", &runtime.env), ("agent", &record.config.env)] {
        for (key, value) in map {
            if RESERVED_ENV.contains(&key.as_str()) {
                return Err(HostError::Rejected(format!(
                    "{source} env must not set reserved variable {key}"
                )));
            }
            env.insert(key.clone(), value.clone());
        }
    }
    env.insert("BUZZ_RELAY_URL".into(), relay_url.to_string());
    env.insert("BUZZ_PRIVATE_KEY".into(), agent_secret_hex.to_string());
    if let Some(auth_tag) = &record.auth_tag {
        env.insert("BUZZ_AUTH_TAG".into(), auth_tag.clone());
    }
    env.insert(
        "BUZZ_ACP_AGENT_COMMAND".into(),
        runtime.agent_command.clone(),
    );
    if !runtime.agent_args.is_empty() {
        env.insert("BUZZ_ACP_AGENT_ARGS".into(), runtime.agent_args.clone());
    }
    if let Some(prompt) = &record.config.system_prompt {
        env.insert("BUZZ_ACP_SYSTEM_PROMPT".into(), prompt.clone());
    }
    if let Some(model) = &record.config.model {
        env.insert("BUZZ_ACP_MODEL".into(), model.clone());
    }
    env.insert("BUZZ_MANAGED_AGENT".into(), "1".into());
    Ok(env)
}

struct Supervised {
    label: String,
    state: HostAgentState,
    since: u64,
    restarts: u32,
    log_ring: Arc<Mutex<VecDeque<String>>>,
    /// Send to ask the run loop to exit and kill the child.
    stop_tx: mpsc::Sender<()>,
}

/// Supervisor over all hosted agent child processes.
#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<Mutex<HashMap<String, Supervised>>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Supervisor {
    /// Create an empty supervisor.
    pub fn new() -> Self {
        Self::default()
    }

    /// Start supervising an agent: spawns the child and a monitor task
    /// that restarts it with backoff until stopped.
    ///
    /// Replaces (stopping first) any existing supervision for the pubkey.
    pub async fn start(
        &self,
        record: &AgentRecord,
        config: &HostConfig,
        agent_secret_hex: String,
    ) -> Result<(), HostError> {
        let runtime = config.runtimes.get(&record.config.runtime).ok_or_else(|| {
            HostError::Rejected(format!(
                "runtime {:?} is not configured on this host",
                record.config.runtime
            ))
        })?;
        let env = render_env(record, runtime, &config.relay_url, &agent_secret_hex)?;

        self.stop(&record.pubkey).await;

        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let log_ring = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_RING_CAP)));
        {
            let mut inner = self.inner.lock().expect("supervisor lock");
            inner.insert(
                record.pubkey.clone(),
                Supervised {
                    label: record.config.label.clone(),
                    state: HostAgentState::Running,
                    since: now_secs(),
                    restarts: 0,
                    log_ring: log_ring.clone(),
                    stop_tx,
                },
            );
        }

        let pubkey = record.pubkey.clone();
        let harness = runtime.harness.clone();
        let log_path = Some(config.state_dir.join("logs").join(format!("{pubkey}.log")));
        let inner = self.inner.clone();

        tokio::spawn(async move {
            let mut backoff = BACKOFF_MIN;
            loop {
                let started = tokio::time::Instant::now();
                let mut command = tokio::process::Command::new(&harness);
                command
                    .env_clear()
                    .envs(&env)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                // Children need a sane PATH for the runtime's own subprocesses.
                if let Ok(path) = std::env::var("PATH") {
                    command.env("PATH", path);
                }
                if let Ok(home) = std::env::var("HOME") {
                    command.env("HOME", home);
                }

                let mut child = match command.spawn() {
                    Ok(child) => child,
                    Err(e) => {
                        warn!(agent = %pubkey, "spawn failed: {e}");
                        set_state(&inner, &pubkey, HostAgentState::Backoff);
                        push_log(&log_ring, format!("[host] spawn failed: {e}"), &log_path);
                        if wait_or_stop(&mut stop_rx, backoff).await {
                            break;
                        }
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                        continue;
                    }
                };

                info!(agent = %pubkey, pid = child.id(), "agent child started");
                set_state(&inner, &pubkey, HostAgentState::Running);
                push_log(&log_ring, "[host] agent started".to_string(), &log_path);

                // Drain stdout/stderr into the ring + log file.
                let mut readers = Vec::new();
                if let Some(stdout) = child.stdout.take() {
                    readers.push(spawn_reader(stdout, log_ring.clone(), log_path.clone()));
                }
                if let Some(stderr) = child.stderr.take() {
                    readers.push(spawn_reader(stderr, log_ring.clone(), log_path.clone()));
                }

                let exited = tokio::select! {
                    status = child.wait() => Some(status),
                    _ = stop_rx.recv() => None,
                };
                for reader in readers {
                    reader.abort();
                }

                match exited {
                    None => {
                        // Deliberate stop.
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        push_log(&log_ring, "[host] agent stopped".to_string(), &log_path);
                        break;
                    }
                    Some(status) => {
                        let code = status
                            .ok()
                            .and_then(|s| s.code())
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "signal".into());
                        warn!(agent = %pubkey, code = %code, "agent child exited");
                        push_log(
                            &log_ring,
                            format!("[host] agent exited (code {code}), restarting"),
                            &log_path,
                        );
                        if started.elapsed() >= STABLE_RUN {
                            backoff = BACKOFF_MIN;
                        }
                        set_state(&inner, &pubkey, HostAgentState::Backoff);
                        bump_restarts(&inner, &pubkey);
                        if wait_or_stop(&mut stop_rx, backoff).await {
                            break;
                        }
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                    }
                }
            }
            set_state(&inner, &pubkey, HostAgentState::Stopped);
        });

        Ok(())
    }

    /// Stop supervising an agent (idempotent). The monitor task kills the
    /// child and exits.
    pub async fn stop(&self, pubkey: &str) {
        let stop_tx = {
            let inner = self.inner.lock().expect("supervisor lock");
            inner.get(pubkey).map(|s| s.stop_tx.clone())
        };
        if let Some(tx) = stop_tx {
            let _ = tx.send(()).await;
        }
    }

    /// Remove an agent from supervision entirely (after stopping it).
    pub async fn remove(&self, pubkey: &str) {
        self.stop(pubkey).await;
        // Give the monitor task a beat to observe the stop.
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.inner.lock().expect("supervisor lock").remove(pubkey);
    }

    /// Status of one agent, if supervised.
    pub fn status_of(&self, pubkey: &str) -> Option<HostAgentStatus> {
        let inner = self.inner.lock().expect("supervisor lock");
        inner.get(pubkey).map(|s| HostAgentStatus {
            agent: pubkey.to_string(),
            label: s.label.clone(),
            state: s.state,
            since: s.since,
            restarts: s.restarts,
        })
    }

    /// Bounded log tail for an agent (newest `lines` lines, oldest first).
    pub fn logs_of(&self, pubkey: &str, lines: usize) -> Option<Vec<String>> {
        let inner = self.inner.lock().expect("supervisor lock");
        inner.get(pubkey).map(|s| {
            let ring = s.log_ring.lock().expect("log ring lock");
            let skip = ring.len().saturating_sub(lines);
            ring.iter().skip(skip).cloned().collect()
        })
    }
}

fn set_state(inner: &Arc<Mutex<HashMap<String, Supervised>>>, pubkey: &str, state: HostAgentState) {
    if let Some(s) = inner.lock().expect("supervisor lock").get_mut(pubkey) {
        if s.state != state {
            s.state = state;
            s.since = now_secs();
        }
    }
}

fn bump_restarts(inner: &Arc<Mutex<HashMap<String, Supervised>>>, pubkey: &str) {
    if let Some(s) = inner.lock().expect("supervisor lock").get_mut(pubkey) {
        s.restarts = s.restarts.saturating_add(1);
    }
}

fn push_log(
    ring: &Arc<Mutex<VecDeque<String>>>,
    line: String,
    log_path: &Option<std::path::PathBuf>,
) {
    if let Some(path) = log_path {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
    let mut ring = ring.lock().expect("log ring lock");
    if ring.len() == LOG_RING_CAP {
        ring.pop_front();
    }
    ring.push_back(line);
}

fn spawn_reader<R>(
    reader: R,
    ring: Arc<Mutex<VecDeque<String>>>,
    log_path: Option<std::path::PathBuf>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            push_log(&ring, line, &log_path);
        }
    })
}

/// Returns true if a stop was requested while waiting out `dur`.
async fn wait_or_stop(stop_rx: &mut mpsc::Receiver<()>, dur: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(dur) => false,
        _ = stop_rx.recv() => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_with_env(env: BTreeMap<String, String>) -> AgentRecord {
        AgentRecord {
            pubkey: "ab".repeat(32),
            owner: "cd".repeat(32),
            config: buzz_core::host::HostAgentConfig {
                label: "researcher".into(),
                runtime: "claude".into(),
                system_prompt: Some("be thorough".into()),
                model: Some("opus".into()),
                provider: None,
                env,
            },
            auth_tag: Some(r#"["auth","owner","","sig"]"#.into()),
            desired_run: true,
            created_at: 0,
        }
    }

    fn runtime() -> RuntimeSpec {
        RuntimeSpec {
            label: "Claude Code".into(),
            harness: "/usr/local/bin/buzz-acp".into(),
            agent_command: "claude-code-acp".into(),
            agent_args: String::new(),
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn render_env_injects_identity_and_config() {
        let record = record_with_env(BTreeMap::from([("EXTRA".into(), "1".into())]));
        let env = render_env(&record, &runtime(), "ws://relay:3000", "secret-hex").unwrap();
        assert_eq!(env["BUZZ_RELAY_URL"], "ws://relay:3000");
        assert_eq!(env["BUZZ_PRIVATE_KEY"], "secret-hex");
        assert_eq!(env["BUZZ_AUTH_TAG"], r#"["auth","owner","","sig"]"#);
        assert_eq!(env["BUZZ_ACP_AGENT_COMMAND"], "claude-code-acp");
        assert_eq!(env["BUZZ_ACP_SYSTEM_PROMPT"], "be thorough");
        assert_eq!(env["BUZZ_ACP_MODEL"], "opus");
        assert_eq!(env["EXTRA"], "1");
        assert_eq!(env["BUZZ_MANAGED_AGENT"], "1");
    }

    #[test]
    fn render_env_rejects_reserved_overrides() {
        for reserved in ["BUZZ_PRIVATE_KEY", "BUZZ_AUTH_TAG", "BUZZ_RELAY_URL"] {
            let record = record_with_env(BTreeMap::from([(reserved.to_string(), "hijack".into())]));
            let err = render_env(&record, &runtime(), "ws://relay:3000", "s").unwrap_err();
            assert!(err.to_string().contains(reserved), "{err}");
        }
    }

    #[test]
    fn render_env_omits_auth_tag_before_grant() {
        let mut record = record_with_env(BTreeMap::new());
        record.auth_tag = None;
        let env = render_env(&record, &runtime(), "ws://relay:3000", "s").unwrap();
        assert!(!env.contains_key("BUZZ_AUTH_TAG"));
    }
}
