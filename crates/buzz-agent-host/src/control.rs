//! Relay connection, subscriptions, and control-frame dispatch.
//!
//! One sequential loop owns the WebSocket: it authenticates (NIP-42),
//! publishes the host announcement, opens two standing subscriptions —
//! `ctl` for kind 24300 frames addressed to the host, `roster` for the
//! relay's kind 13534 membership snapshot (replaceable, so membership
//! changes arrive live) — and dispatches ops one at a time. Sequential
//! processing is deliberate: every op is quick (spawns are non-blocking),
//! and it makes the store's read-modify-write cycles trivially safe.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use buzz_core::host::{
    HostAgentState, HostAgentStatus, HostControlReply, HostControlRequest, HOST_LOGS_MAX_LINES,
};
use buzz_core::kind::{KIND_AGENT_HOST_CONTROL, KIND_NIP43_MEMBERSHIP_LIST};
use buzz_sdk::host::{
    build_control_reply, build_host_announcement, control_frame_meta, decrypt_control_request,
    ControlFrameDirection,
};
use buzz_ws_client::{NostrWsConnection, RelayMessage, WsClientError};
use nostr::{Event, Keys, PublicKey};
use serde_json::json;
use tracing::{info, warn};

use crate::authz;
use crate::config::HostConfig;
use crate::state::{AgentRecord, StateStore};
use crate::supervise::Supervisor;
use crate::HostError;

/// Idle receive timeout — purely a loop heartbeat, not a failure.
const RECV_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-sender request budget (requests per minute).
const SENDER_RATE_LIMIT: u32 = 60;
/// Recently processed event ids retained for dedup.
const DEDUP_CAP: usize = 512;

/// The daemon: configuration, identity, desired state, and supervision.
pub struct Daemon {
    config: HostConfig,
    keys: Keys,
    store: StateStore,
    supervisor: Supervisor,
    roster: authz::Roster,
    rate: HashMap<String, (u32, Instant)>,
    seen: VecDeque<nostr::EventId>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Daemon {
    /// Build a daemon from config and identity; opens the state store.
    pub fn new(config: HostConfig, keys: Keys) -> Result<Self, HostError> {
        let store = StateStore::open(&config.state_dir)?;
        Ok(Self {
            config,
            keys,
            store,
            supervisor: Supervisor::new(),
            roster: authz::Roster::default(),
            rate: HashMap::new(),
            seen: VecDeque::new(),
        })
    }

    /// The daemon's public key (register this as a community member).
    pub fn public_key(&self) -> PublicKey {
        self.keys.public_key()
    }

    /// Reconcile desired state into running children. Called once at
    /// startup, before the relay loop, so agents come back even while the
    /// relay is unreachable.
    pub async fn reconcile(&mut self) {
        let to_start: Vec<AgentRecord> = self
            .store
            .agents()
            .filter(|r| r.desired_run && r.auth_tag.is_some())
            .cloned()
            .collect();
        for record in to_start {
            match self.store.load_agent_secret(&record.pubkey) {
                Ok(secret) => {
                    if let Err(e) = self.supervisor.start(&record, &self.config, secret).await {
                        warn!(agent = %record.pubkey, "reconcile start failed: {e}");
                    } else {
                        info!(agent = %record.pubkey, label = %record.config.label, "reconciled");
                    }
                }
                Err(e) => warn!(agent = %record.pubkey, "reconcile: missing key: {e}"),
            }
        }
    }

    /// Run the relay loop forever, reconnecting with bounded backoff.
    pub async fn run(&mut self) -> Result<(), HostError> {
        let mut backoff = Duration::from_secs(1);
        loop {
            match self.run_connection().await {
                Ok(()) => backoff = Duration::from_secs(1),
                Err(e) => {
                    warn!("relay connection lost: {e}; reconnecting in {backoff:?}");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                }
            }
        }
    }

    /// One connection lifetime: authenticate, announce, subscribe, serve.
    async fn run_connection(&mut self) -> Result<(), WsClientError> {
        let mut conn =
            NostrWsConnection::connect_authenticated(&self.config.relay_url, &self.keys, None)
                .await?;
        info!(host = %self.keys.public_key().to_hex(), "connected and authenticated");

        self.publish_announcement(&mut conn).await?;

        let me = self.keys.public_key().to_hex();
        conn.send_raw(&json!([
            "REQ",
            "ctl",
            { "kinds": [KIND_AGENT_HOST_CONTROL], "#p": [me] }
        ]))
        .await?;
        conn.send_raw(&json!([
            "REQ",
            "roster",
            { "kinds": [KIND_NIP43_MEMBERSHIP_LIST], "limit": 1 }
        ]))
        .await?;

        loop {
            match conn.next_event(RECV_TIMEOUT).await {
                Ok(RelayMessage::Event {
                    subscription_id,
                    event,
                }) => match subscription_id.as_str() {
                    "roster" => {
                        self.roster = authz::Roster::from_snapshot(&event);
                        info!(members = self.roster.len(), "membership roster updated");
                    }
                    "ctl" => {
                        if let Some((recipient, req_id, reply)) = self.handle_frame(&event).await {
                            self.send_reply(&mut conn, &recipient, &req_id, &reply)
                                .await;
                        }
                    }
                    _ => {}
                },
                Ok(RelayMessage::Closed {
                    subscription_id,
                    message,
                }) => {
                    warn!(sub = %subscription_id, %message, "subscription closed by relay");
                    if subscription_id == "ctl" {
                        return Err(WsClientError::ConnectionClosed);
                    }
                }
                Ok(_) => {}
                Err(WsClientError::Timeout) => {} // idle heartbeat
                Err(e) => return Err(e),
            }
        }
    }

    /// Publish (replace) the kind 30178 announcement.
    async fn publish_announcement(
        &mut self,
        conn: &mut NostrWsConnection,
    ) -> Result<(), WsClientError> {
        let content = self
            .config
            .announce_content(env!("CARGO_PKG_VERSION"), self.store.len() as u32);
        let event = build_host_announcement(&self.config.host_id, &content)
            .and_then(|b| {
                b.sign_with_keys(&self.keys)
                    .map_err(|e| buzz_sdk::SdkError::InvalidInput(e.to_string()))
            })
            .map_err(|e| WsClientError::EventBuilder(format!("build announcement: {e}")))?;
        let ok = conn.send_event(event).await?;
        if !ok.accepted {
            warn!(reason = %ok.message, "announcement rejected by relay");
        } else {
            info!(host_id = %self.config.host_id, "announcement published");
        }
        Ok(())
    }

    async fn send_reply(
        &mut self,
        conn: &mut NostrWsConnection,
        recipient: &PublicKey,
        req_id: &str,
        reply: &HostControlReply,
    ) {
        let built = build_control_reply(&self.keys, recipient, req_id, reply).and_then(|b| {
            b.sign_with_keys(&self.keys)
                .map_err(|e| buzz_sdk::SdkError::InvalidInput(e.to_string()))
        });
        match built {
            Ok(event) => {
                if let Err(e) = conn.send_event(event).await {
                    warn!("reply publish failed: {e}");
                }
            }
            Err(e) => warn!("reply build failed: {e}"),
        }
    }

    /// Validate, decrypt, and dispatch one control frame. Returns the
    /// reply routing (recipient, req id, reply) or `None` to stay silent
    /// (malformed frames and rate-limited senders get no reply).
    async fn handle_frame(
        &mut self,
        event: &Event,
    ) -> Option<(PublicKey, String, HostControlReply)> {
        let meta = match control_frame_meta(event) {
            Ok(meta) => meta,
            Err(e) => {
                warn!("dropping malformed control frame: {e}");
                return None;
            }
        };
        if meta.direction != ControlFrameDirection::Request {
            return None; // our own replies echo back through the fan-out
        }
        if meta.host_pubkey != self.keys.public_key() {
            return None;
        }
        if self.seen.contains(&event.id) {
            return None;
        }
        if self.seen.len() == DEDUP_CAP {
            self.seen.pop_front();
        }
        self.seen.push_back(event.id);

        let sender = event.pubkey;
        let req_id = meta.req_id.clone();

        if self.rate_limited(&sender) {
            warn!(sender = %sender.to_hex(), "rate limited");
            return None;
        }
        if let Err(e) = authz::check_freshness(event) {
            return Some((
                sender,
                req_id,
                HostControlReply::Error {
                    message: e.to_string(),
                },
            ));
        }
        if let Err(e) = authz::check_sender(&sender, &self.roster, &self.config.policy) {
            warn!(sender = %sender.to_hex(), "rejected: {e}");
            return Some((
                sender,
                req_id,
                HostControlReply::Error {
                    message: e.to_string(),
                },
            ));
        }

        let request = match decrypt_control_request(&self.keys, event) {
            Ok(request) => request,
            Err(e) => {
                warn!(sender = %sender.to_hex(), "undecryptable control frame: {e}");
                return Some((
                    sender,
                    req_id,
                    HostControlReply::Error {
                        message: "cannot decrypt request".into(),
                    },
                ));
            }
        };

        let op_name = op_name(&request);
        let reply = match self.dispatch(&sender, request).await {
            Ok(reply) => reply,
            Err(HostError::Rejected(message)) => HostControlReply::Error { message },
            Err(e) => {
                warn!(sender = %sender.to_hex(), op = op_name, "internal error: {e}");
                HostControlReply::Error {
                    message: "internal error".into(),
                }
            }
        };
        info!(
            sender = %sender.to_hex(),
            op = op_name,
            outcome = if matches!(reply, HostControlReply::Error { .. }) { "rejected" } else { "ok" },
            "control op"
        );
        Some((sender, req_id, reply))
    }

    fn rate_limited(&mut self, sender: &PublicKey) -> bool {
        let now = Instant::now();
        let entry = self.rate.entry(sender.to_hex()).or_insert((0, now));
        if now.duration_since(entry.1) >= Duration::from_secs(60) {
            *entry = (1, now);
            false
        } else {
            entry.0 += 1;
            entry.0 > SENDER_RATE_LIMIT
        }
    }

    /// Execute one authorized, decrypted op.
    async fn dispatch(
        &mut self,
        sender: &PublicKey,
        request: HostControlRequest,
    ) -> Result<HostControlReply, HostError> {
        match request {
            HostControlRequest::Create { config } => self.op_create(sender, config).await,
            HostControlRequest::Grant { agent, auth_tag } => {
                self.op_grant(sender, &agent, auth_tag).await
            }
            HostControlRequest::Configure { agent, config } => {
                self.op_configure(sender, &agent, config).await
            }
            HostControlRequest::Start { agent } => self.op_start(sender, &agent).await,
            HostControlRequest::Stop { agent } => self.op_stop(sender, &agent).await,
            HostControlRequest::Remove { agent } => self.op_remove(sender, &agent).await,
            HostControlRequest::Status { agent } => self.op_status(sender, agent.as_deref()),
            HostControlRequest::Logs { agent, lines } => self.op_logs(sender, &agent, lines),
        }
    }

    async fn op_create(
        &mut self,
        sender: &PublicKey,
        config: buzz_core::host::HostAgentConfig,
    ) -> Result<HostControlReply, HostError> {
        self.validate_config(&config)?;
        let max = self.config.policy.effective_max_agents() as usize;
        if self.store.len() >= max {
            return Err(HostError::Rejected(format!(
                "host is at capacity ({max} agents)"
            )));
        }
        let per_owner = self.config.policy.max_agents_per_owner as usize;
        if per_owner > 0 && self.store.agents_owned_by(&sender.to_hex()).count() >= per_owner {
            return Err(HostError::Rejected(format!(
                "owner is at quota ({per_owner} agents)"
            )));
        }

        let keys = self.store.generate_agent_keys(None)?;
        let pubkey = keys.public_key().to_hex();
        let record = AgentRecord {
            pubkey: pubkey.clone(),
            owner: sender.to_hex(),
            config,
            auth_tag: None,
            desired_run: false,
            created_at: now_secs(),
        };
        self.store.upsert(record)?;
        info!(agent = %pubkey, owner = %sender.to_hex(), "agent created");
        Ok(HostControlReply::Created { agent: pubkey })
    }

    async fn op_grant(
        &mut self,
        sender: &PublicKey,
        agent: &str,
        auth_tag: String,
    ) -> Result<HostControlReply, HostError> {
        let record = self.owned_record(sender, agent)?;
        let agent_pubkey = PublicKey::from_hex(agent)
            .map_err(|e| HostError::Rejected(format!("invalid agent pubkey: {e}")))?;
        authz::check_grant(sender, &agent_pubkey, &auth_tag)?;

        let mut record = record;
        record.auth_tag = Some(auth_tag);
        record.desired_run = true;
        self.store.upsert(record.clone())?;

        let secret = self.store.load_agent_secret(agent)?;
        self.supervisor.start(&record, &self.config, secret).await?;
        Ok(HostControlReply::Granted {
            agent: agent.to_string(),
        })
    }

    async fn op_configure(
        &mut self,
        sender: &PublicKey,
        agent: &str,
        config: buzz_core::host::HostAgentConfig,
    ) -> Result<HostControlReply, HostError> {
        self.validate_config(&config)?;
        let mut record = self.owned_record(sender, agent)?;
        record.config = config;
        self.store.upsert(record.clone())?;

        if record.desired_run && record.auth_tag.is_some() {
            let secret = self.store.load_agent_secret(agent)?;
            self.supervisor.start(&record, &self.config, secret).await?;
        }
        Ok(HostControlReply::Configured {
            agent: agent.to_string(),
        })
    }

    async fn op_start(
        &mut self,
        sender: &PublicKey,
        agent: &str,
    ) -> Result<HostControlReply, HostError> {
        let mut record = self.owned_record(sender, agent)?;
        if record.auth_tag.is_none() {
            return Err(HostError::Rejected(
                "agent has no owner grant yet — send grant first".into(),
            ));
        }
        record.desired_run = true;
        self.store.upsert(record.clone())?;
        let secret = self.store.load_agent_secret(agent)?;
        self.supervisor.start(&record, &self.config, secret).await?;
        Ok(HostControlReply::Accepted {
            agent: agent.to_string(),
        })
    }

    async fn op_stop(
        &mut self,
        sender: &PublicKey,
        agent: &str,
    ) -> Result<HostControlReply, HostError> {
        let mut record = self.owned_record(sender, agent)?;
        record.desired_run = false;
        self.store.upsert(record)?;
        self.supervisor.stop(agent).await;
        Ok(HostControlReply::Accepted {
            agent: agent.to_string(),
        })
    }

    async fn op_remove(
        &mut self,
        sender: &PublicKey,
        agent: &str,
    ) -> Result<HostControlReply, HostError> {
        let _ = self.owned_record(sender, agent)?;
        self.supervisor.remove(agent).await;
        self.store.remove(agent)?;
        info!(agent = %agent, "agent removed");
        Ok(HostControlReply::Accepted {
            agent: agent.to_string(),
        })
    }

    fn op_status(
        &self,
        sender: &PublicKey,
        agent: Option<&str>,
    ) -> Result<HostControlReply, HostError> {
        let sender_hex = sender.to_hex();
        let records: Vec<&AgentRecord> = match agent {
            Some(pubkey) => {
                let record = self
                    .store
                    .get(pubkey)
                    .ok_or_else(|| HostError::Rejected("unknown agent".into()))?;
                authz::check_owner(sender, record)?;
                vec![record]
            }
            None => self.store.agents_owned_by(&sender_hex).collect(),
        };
        let agents = records
            .into_iter()
            .map(|record| {
                self.supervisor
                    .status_of(&record.pubkey)
                    .unwrap_or_else(|| HostAgentStatus {
                        agent: record.pubkey.clone(),
                        label: record.config.label.clone(),
                        state: if record.auth_tag.is_none() {
                            HostAgentState::AwaitingGrant
                        } else {
                            HostAgentState::Stopped
                        },
                        since: record.created_at,
                        restarts: 0,
                    })
            })
            .collect();
        Ok(HostControlReply::Status { agents })
    }

    fn op_logs(
        &self,
        sender: &PublicKey,
        agent: &str,
        lines: u32,
    ) -> Result<HostControlReply, HostError> {
        let record = self
            .store
            .get(agent)
            .ok_or_else(|| HostError::Rejected("unknown agent".into()))?;
        authz::check_owner(sender, record)?;
        let lines = lines.min(HOST_LOGS_MAX_LINES) as usize;
        let tail = match self.supervisor.logs_of(agent, lines) {
            Some(tail) => tail,
            None => read_log_tail(&self.store.log_path(agent), lines),
        };
        Ok(HostControlReply::Logs {
            agent: agent.to_string(),
            lines: tail,
        })
    }

    fn owned_record(&self, sender: &PublicKey, agent: &str) -> Result<AgentRecord, HostError> {
        let record = self
            .store
            .get(agent)
            .ok_or_else(|| HostError::Rejected("unknown agent".into()))?;
        authz::check_owner(sender, record)?;
        Ok(record.clone())
    }

    fn validate_config(&self, config: &buzz_core::host::HostAgentConfig) -> Result<(), HostError> {
        if config.label.trim().is_empty() || config.label.len() > 128 {
            return Err(HostError::Rejected("label must be 1–128 chars".into()));
        }
        if !self.config.runtimes.contains_key(&config.runtime) {
            let known: Vec<&str> = self.config.runtimes.keys().map(String::as_str).collect();
            return Err(HostError::Rejected(format!(
                "runtime {:?} is not advertised by this host (known: {})",
                config.runtime,
                known.join(", ")
            )));
        }
        Ok(())
    }
}

fn op_name(request: &HostControlRequest) -> &'static str {
    match request {
        HostControlRequest::Create { .. } => "create",
        HostControlRequest::Grant { .. } => "grant",
        HostControlRequest::Configure { .. } => "configure",
        HostControlRequest::Start { .. } => "start",
        HostControlRequest::Stop { .. } => "stop",
        HostControlRequest::Remove { .. } => "remove",
        HostControlRequest::Status { .. } => "status",
        HostControlRequest::Logs { .. } => "logs",
    }
}

/// Read the last `lines` lines of a log file (best effort).
fn read_log_tail(path: &std::path::Path, lines: usize) -> Vec<String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let all: Vec<&str> = contents.lines().collect();
            let skip = all.len().saturating_sub(lines);
            all[skip..].iter().map(|s| s.to_string()).collect()
        }
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn test_daemon() -> (Daemon, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let config: HostConfig = toml::from_str(&format!(
            r#"
host_id = "test"
label = "test host"
relay_url = "ws://localhost:1"
state_dir = "{}"

[runtimes.claude]
label = "Claude Code"
harness = "/usr/bin/false"
agent_command = "claude-code-acp"

[policy]
max_agents = 2
max_agents_per_owner = 1
"#,
            dir.path().display()
        ))
        .unwrap();
        let daemon = Daemon::new(config, Keys::generate()).unwrap();
        (daemon, dir)
    }

    fn agent_config(runtime: &str) -> buzz_core::host::HostAgentConfig {
        buzz_core::host::HostAgentConfig {
            label: "researcher".into(),
            runtime: runtime.into(),
            system_prompt: Some("be thorough".into()),
            model: None,
            provider: None,
            env: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn create_generates_identity_and_stores_record() {
        let (mut daemon, _dir) = test_daemon();
        let owner = Keys::generate();
        let reply = daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Create {
                    config: agent_config("claude"),
                },
            )
            .await
            .unwrap();
        let HostControlReply::Created { agent } = reply else {
            panic!("expected Created, got {reply:?}");
        };
        let record = daemon.store.get(&agent).unwrap();
        assert_eq!(record.owner, owner.public_key().to_hex());
        assert!(record.auth_tag.is_none());
        assert!(!record.desired_run);
        // Host-side key exists and matches the returned pubkey.
        let secret = daemon.store.load_agent_secret(&agent).unwrap();
        assert_eq!(Keys::parse(&secret).unwrap().public_key().to_hex(), agent);
    }

    #[tokio::test]
    async fn create_rejects_unknown_runtime() {
        let (mut daemon, _dir) = test_daemon();
        let owner = Keys::generate();
        let err = daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Create {
                    config: agent_config("goose"),
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not advertised"));
    }

    #[tokio::test]
    async fn per_owner_quota_enforced() {
        let (mut daemon, _dir) = test_daemon();
        let owner = Keys::generate();
        daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Create {
                    config: agent_config("claude"),
                },
            )
            .await
            .unwrap();
        let err = daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Create {
                    config: agent_config("claude"),
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("quota"));
    }

    #[tokio::test]
    async fn grant_verifies_and_starts() {
        let (mut daemon, _dir) = test_daemon();
        let owner = Keys::generate();
        let HostControlReply::Created { agent } = daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Create {
                    config: agent_config("claude"),
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        let agent_pk = PublicKey::from_hex(&agent).unwrap();
        let tag = buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent_pk, "").unwrap();

        // Wrong sender cannot grant.
        let stranger = Keys::generate();
        assert!(daemon
            .dispatch(
                &stranger.public_key(),
                HostControlRequest::Grant {
                    agent: agent.clone(),
                    auth_tag: tag.clone(),
                },
            )
            .await
            .is_err());

        let reply = daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Grant {
                    agent: agent.clone(),
                    auth_tag: tag,
                },
            )
            .await
            .unwrap();
        assert!(matches!(reply, HostControlReply::Granted { .. }));
        let record = daemon.store.get(&agent).unwrap();
        assert!(record.desired_run);
        assert!(record.auth_tag.is_some());
    }

    #[tokio::test]
    async fn status_scopes_to_owner() {
        let (mut daemon, _dir) = test_daemon();
        let alice = Keys::generate();
        let bob = Keys::generate();
        let HostControlReply::Created { agent } = daemon
            .dispatch(
                &alice.public_key(),
                HostControlRequest::Create {
                    config: agent_config("claude"),
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };

        // Bob sees nothing; alice sees hers as awaiting grant.
        let HostControlReply::Status { agents } = daemon
            .dispatch(
                &bob.public_key(),
                HostControlRequest::Status { agent: None },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        assert!(agents.is_empty());

        let HostControlReply::Status { agents } = daemon
            .dispatch(
                &alice.public_key(),
                HostControlRequest::Status { agent: None },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].state, HostAgentState::AwaitingGrant);

        // Bob cannot read alice's agent by pubkey either.
        assert!(daemon
            .dispatch(
                &bob.public_key(),
                HostControlRequest::Status {
                    agent: Some(agent.clone()),
                },
            )
            .await
            .is_err());

        // Nor her logs.
        assert!(daemon
            .dispatch(
                &bob.public_key(),
                HostControlRequest::Logs { agent, lines: 10 },
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn remove_cleans_up_state() {
        let (mut daemon, dir) = test_daemon();
        let owner = Keys::generate();
        let HostControlReply::Created { agent } = daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Create {
                    config: agent_config("claude"),
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        daemon
            .dispatch(
                &owner.public_key(),
                HostControlRequest::Remove {
                    agent: agent.clone(),
                },
            )
            .await
            .unwrap();
        assert!(daemon.store.get(&agent).is_none());
        assert!(!dir
            .path()
            .join("keys")
            .join(format!("{agent}.key"))
            .exists());
    }

    #[test]
    fn rate_limiter_trips_after_budget() {
        let (mut daemon, _dir) = test_daemon();
        let sender = Keys::generate().public_key();
        for _ in 0..SENDER_RATE_LIMIT {
            assert!(!daemon.rate_limited(&sender));
        }
        assert!(daemon.rate_limited(&sender));
    }
}
