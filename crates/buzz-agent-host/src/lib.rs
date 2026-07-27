#![deny(unsafe_code)]
#![warn(missing_docs)]
//! `buzz-agent-host` — always-on daemon that runs Buzz agents on a remote
//! host, controlled entirely over the relay.
//!
//! The daemon joins a community as a member with its own keypair,
//! advertises launchable runtimes via a durable kind 30178 announcement,
//! and accepts NIP-44 encrypted kind 24300 control frames (create, grant,
//! configure, start, stop, remove, status, logs) from authorized members.
//! Agent keypairs are generated host-side and never transit the network.
//! Agents run as directly supervised `buzz-acp` child processes — no
//! shell, no sudo, no systemd templating.
//!
//! See `docs/remote-persistent-configurable-agents.md`.

pub mod authz;
pub mod config;
pub mod control;
pub mod state;
pub mod supervise;

pub use config::HostConfig;
pub use control::Daemon;

/// Errors surfaced by the daemon.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// Configuration file problems.
    #[error("config error: {0}")]
    Config(String),
    /// Desired-state store problems.
    #[error("state error: {0}")]
    State(String),
    /// A request was rejected (authorization, validation, policy). The
    /// message is safe to echo to the requester.
    #[error("{0}")]
    Rejected(String),
}
