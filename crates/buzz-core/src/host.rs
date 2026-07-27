//! Agent-host protocol wire types and envelope helpers.
//!
//! A `buzz-agent-host` daemon advertises itself with a durable
//! [`crate::kind::KIND_AGENT_HOST_ANNOUNCE`] (30178) event and accepts
//! lifecycle operations over ephemeral, NIP-44 encrypted
//! [`crate::kind::KIND_AGENT_HOST_CONTROL`] (24300) request/reply frames.
//! This module owns the plaintext payload types for both kinds and the
//! encrypt/decrypt envelope; event assembly and tag parsing live in
//! `buzz-sdk::host`. See `docs/remote-persistent-configurable-agents.md`.
//!
//! # Secrets discipline
//!
//! Announcements are world-readable and MUST stay secret-free. Control
//! frames may carry provider env vars, system prompts, and log tails —
//! never the agent's private key: keypairs are generated on the host and
//! no secret key material ever appears in any payload type here, in
//! either direction.

use std::collections::BTreeMap;

use nostr::{Event, Keys, PublicKey};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::observer::{decrypt_observer_payload, encrypt_observer_payload, ObserverPayloadError};

/// Tag name carrying the host pubkey on control frames (requests and replies).
pub const HOST_TAG: &str = "host";
/// Tag name carrying the cleartext frame direction on control frames.
pub const HOST_FRAME_TAG: &str = "frame";
/// Frame value for owner-to-host requests.
pub const HOST_FRAME_REQUEST: &str = "request";
/// Frame value for host-to-owner replies.
pub const HOST_FRAME_REPLY: &str = "reply";
/// Tag name carrying the request-correlation id on control frames.
pub const HOST_REQ_TAG: &str = "req";

/// Errors from control-frame payload encryption/decryption.
///
/// Control frames reuse the NIP-44 payload envelope shared with agent
/// observer frames (kind 24200), including its ciphertext and plaintext
/// size bounds.
pub type HostPayloadError = ObserverPayloadError;

/// Maximum accepted `logs` tail length, in lines.
pub const HOST_LOGS_MAX_LINES: u32 = 500;

// ── kind 30178: host announcement (plaintext JSON content) ───────────────

/// Content body of a host announcement event (kind 30178).
///
/// World-readable; must never carry secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostAnnounceContent {
    /// Human-readable host name shown in Desktop's host picker.
    pub label: String,
    /// Daemon version string.
    pub version: String,
    /// Launchable runtimes — the host's capability boundary. A control
    /// frame can only name a runtime id from this list.
    pub runtimes: Vec<HostRuntime>,
    /// Capacity advertisement.
    pub capacity: HostCapacity,
    /// Who the host accepts control requests from.
    pub accepts_from: HostAcceptsFrom,
}

/// One launchable runtime advertised by a host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRuntime {
    /// Stable runtime id, referenced by [`HostAgentConfig::runtime`].
    pub id: String,
    /// Human-readable label shown in Desktop's runtime dropdown.
    pub label: String,
}

/// Host capacity advertisement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostCapacity {
    /// Maximum agents the host will supervise.
    pub max_agents: u32,
    /// Agents currently in the host's desired-state store.
    pub deployed: u32,
}

/// Host acceptance policy for control requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostAcceptsFrom {
    /// Any current community member may send control requests.
    Members,
    /// Only pubkeys on the host's local allowlist may send control requests.
    Allowlist,
}

// ── kind 24300: control frames (NIP-44 encrypted content) ────────────────

/// Agent configuration carried by `create` and `configure` requests.
///
/// The host renders this into the `BUZZ_ACP_*` env of a supervised
/// `buzz-acp` process. Identity fields are absent by design: the keypair is
/// generated host-side (`create` reply carries the pubkey) and the NIP-OA
/// auth tag arrives separately via [`HostControlRequest::Grant`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostAgentConfig {
    /// Display name for the agent.
    pub label: String,
    /// Runtime id — must appear in the host's announced [`HostRuntime`] list.
    pub runtime: String,
    /// System prompt (`BUZZ_ACP_SYSTEM_PROMPT`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Model override (`BUZZ_ACP_MODEL`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Extra environment variables for the harness process. May carry
    /// provider API keys — one reason control frames are encrypted and
    /// ephemeral. Never rendered into announcements, replies, or logs.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// A control request, owner → host (NIP-44 plaintext of a request frame).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HostControlRequest {
    /// Create an agent: the host generates its keypair, persists desired
    /// state, and replies [`HostControlReply::Created`] with the pubkey.
    /// The agent is not started until a `grant` arrives.
    Create {
        /// Agent configuration.
        config: HostAgentConfig,
    },
    /// Deliver the owner-minted NIP-OA auth tag for a created agent; the
    /// host verifies it and starts the agent.
    Grant {
        /// Agent pubkey (hex) returned by `create`.
        agent: String,
        /// NIP-OA auth tag JSON (`["auth", owner, conditions, sig]`).
        auth_tag: String,
    },
    /// Replace the agent's configuration wholesale and restart it if
    /// running. This is the "edit instructions from Desktop" path.
    Configure {
        /// Agent pubkey (hex).
        agent: String,
        /// Full replacement configuration.
        config: HostAgentConfig,
    },
    /// Start a stopped agent.
    Start {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// Stop a running agent.
    Stop {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// Stop the agent and delete its desired state and key material.
    Remove {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// Report status for one agent, or all of the sender's agents.
    Status {
        /// Agent pubkey (hex); `None` means all agents owned by the sender.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    /// Return a bounded log tail for an agent.
    Logs {
        /// Agent pubkey (hex).
        agent: String,
        /// Number of lines requested (capped at [`HOST_LOGS_MAX_LINES`]).
        lines: u32,
    },
}

/// A control reply, host → owner (NIP-44 plaintext of a reply frame).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum HostControlReply {
    /// The request was rejected or failed.
    Error {
        /// Human-readable reason. Must not echo config env values.
        message: String,
    },
    /// `create` succeeded — the agent's host-generated pubkey.
    Created {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// `grant` succeeded and the agent is starting.
    Granted {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// `configure` was applied.
    Configured {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// A lifecycle op (`start`/`stop`/`remove`) was accepted; liveness is
    /// observable through the agent's own presence events.
    Accepted {
        /// Agent pubkey (hex).
        agent: String,
    },
    /// `status` result.
    Status {
        /// One entry per agent in scope.
        agents: Vec<HostAgentStatus>,
    },
    /// `logs` result.
    Logs {
        /// Agent pubkey (hex).
        agent: String,
        /// Log tail, oldest first, at most the requested line count.
        lines: Vec<String>,
    },
}

/// Per-agent status entry in a [`HostControlReply::Status`] reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostAgentStatus {
    /// Agent pubkey (hex).
    pub agent: String,
    /// Display name from the agent's config.
    pub label: String,
    /// Supervision state.
    pub state: HostAgentState,
    /// Unix timestamp of the last state change.
    pub since: u64,
    /// Restart count since the daemon last started.
    pub restarts: u32,
}

/// Supervision state of a hosted agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostAgentState {
    /// Created, awaiting a `grant` — never started.
    AwaitingGrant,
    /// Deliberately stopped.
    Stopped,
    /// Child process running.
    Running,
    /// Crashed; the supervisor is backing off before the next restart.
    Backoff,
}

/// Serialize and NIP-44 encrypt a control payload for `recipient`.
///
/// Shares the ciphertext/plaintext size bounds of the observer envelope.
pub fn encrypt_host_payload<T: Serialize>(
    sender_keys: &Keys,
    recipient: &PublicKey,
    payload: &T,
) -> Result<String, HostPayloadError> {
    encrypt_observer_payload(sender_keys, recipient, payload)
}

/// NIP-44 decrypt and deserialize a control payload from `event`.
pub fn decrypt_host_payload<T: DeserializeOwned>(
    recipient_keys: &Keys,
    event: &Event,
) -> Result<T, HostPayloadError> {
    decrypt_observer_payload(recipient_keys, event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_request_round_trips_all_ops() {
        let requests = vec![
            HostControlRequest::Create {
                config: HostAgentConfig {
                    label: "researcher".into(),
                    runtime: "claude".into(),
                    system_prompt: Some("be thorough".into()),
                    model: None,
                    provider: None,
                    env: BTreeMap::from([("FOO".into(), "bar".into())]),
                },
            },
            HostControlRequest::Grant {
                agent: "ab".repeat(32),
                auth_tag: r#"["auth","<owner>","","<sig>"]"#.into(),
            },
            HostControlRequest::Configure {
                agent: "ab".repeat(32),
                config: HostAgentConfig {
                    label: "researcher".into(),
                    runtime: "claude".into(),
                    system_prompt: None,
                    model: Some("opus".into()),
                    provider: None,
                    env: BTreeMap::new(),
                },
            },
            HostControlRequest::Start {
                agent: "ab".repeat(32),
            },
            HostControlRequest::Stop {
                agent: "ab".repeat(32),
            },
            HostControlRequest::Remove {
                agent: "ab".repeat(32),
            },
            HostControlRequest::Status { agent: None },
            HostControlRequest::Logs {
                agent: "ab".repeat(32),
                lines: 100,
            },
        ];
        for req in requests {
            let json = serde_json::to_string(&req).unwrap();
            let back: HostControlRequest = serde_json::from_str(&json).unwrap();
            assert_eq!(req, back);
        }
    }

    #[test]
    fn control_reply_round_trips() {
        let replies = vec![
            HostControlReply::Error {
                message: "runtime not advertised".into(),
            },
            HostControlReply::Created {
                agent: "ab".repeat(32),
            },
            HostControlReply::Granted {
                agent: "ab".repeat(32),
            },
            HostControlReply::Configured {
                agent: "ab".repeat(32),
            },
            HostControlReply::Accepted {
                agent: "ab".repeat(32),
            },
            HostControlReply::Status {
                agents: vec![HostAgentStatus {
                    agent: "ab".repeat(32),
                    label: "researcher".into(),
                    state: HostAgentState::Running,
                    since: 1_753_000_000,
                    restarts: 2,
                }],
            },
            HostControlReply::Logs {
                agent: "ab".repeat(32),
                lines: vec!["line one".into(), "line two".into()],
            },
        ];
        for reply in replies {
            let json = serde_json::to_string(&reply).unwrap();
            let back: HostControlReply = serde_json::from_str(&json).unwrap();
            assert_eq!(reply, back);
        }
    }

    #[test]
    fn announce_content_round_trips() {
        let content = HostAnnounceContent {
            label: "gradient".into(),
            version: "0.1.0".into(),
            runtimes: vec![HostRuntime {
                id: "claude".into(),
                label: "Claude Code".into(),
            }],
            capacity: HostCapacity {
                max_agents: 32,
                deployed: 5,
            },
            accepts_from: HostAcceptsFrom::Members,
        };
        let json = serde_json::to_string(&content).unwrap();
        let back: HostAnnounceContent = serde_json::from_str(&json).unwrap();
        assert_eq!(content, back);
        // Wire names are snake_case strings, pinned.
        assert!(json.contains(r#""accepts_from":"members""#));
    }

    #[test]
    fn op_wire_names_are_snake_case() {
        let json = serde_json::to_string(&HostControlRequest::Status { agent: None }).unwrap();
        assert_eq!(json, r#"{"op":"status"}"#);
        let json =
            serde_json::to_string(&HostControlRequest::Start { agent: "aa".into() }).unwrap();
        assert!(json.starts_with(r#"{"op":"start""#));
    }

    #[test]
    fn payload_encrypts_and_decrypts_via_nip44() {
        let owner = Keys::generate();
        let host = Keys::generate();
        let req = HostControlRequest::Status { agent: None };
        let ciphertext = encrypt_host_payload(&owner, &host.public_key(), &req).expect("encrypt");

        let event = nostr::EventBuilder::new(
            nostr::Kind::Custom(crate::kind::KIND_AGENT_HOST_CONTROL as u16),
            ciphertext,
        )
        .tags([nostr::Tag::public_key(host.public_key())])
        .sign_with_keys(&owner)
        .expect("sign");

        let back: HostControlRequest = decrypt_host_payload(&host, &event).expect("decrypt");
        assert_eq!(back, req);
    }

    /// The security-critical structural assertion: no payload type in this
    /// module can represent a secret key, so no code path can serialize one
    /// into a control frame in either direction.
    #[test]
    fn no_payload_type_carries_secret_key_fields() {
        for json in [
            serde_json::to_string(&HostControlRequest::Create {
                config: HostAgentConfig {
                    label: "x".into(),
                    runtime: "r".into(),
                    system_prompt: None,
                    model: None,
                    provider: None,
                    env: BTreeMap::new(),
                },
            })
            .unwrap(),
            serde_json::to_string(&HostControlReply::Created { agent: "aa".into() }).unwrap(),
        ] {
            assert!(!json.contains("nsec"));
            assert!(!json.contains("private_key"));
            assert!(!json.contains("secret"));
        }
    }
}
