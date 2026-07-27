//! Relay-native agent-host backend (`BackendKind::Host`).
//!
//! Desktop-side client for `buzz-agent-host` daemons: discovers hosts from
//! their durable kind 30178 announcements, exchanges NIP-44 encrypted kind
//! 24300 control frames signed with the owner key, and pins accepted host
//! pubkeys (trust on first use) so a rogue member cannot silently
//! impersonate a host by reusing its label.
//!
//! The agent's keypair is generated on the host and never reaches this
//! machine; only its pubkey (from the `create` reply) and the owner-minted
//! NIP-OA auth tag (sent in `grant`) exist here.

use std::time::Duration;

use buzz_core_pkg::host::{HostControlReply, HostControlRequest};
use buzz_sdk_pkg::host::{
    control_frame_meta, decrypt_control_reply, parse_host_announcement, ControlFrameDirection,
};
use buzz_ws_client_pkg::{NostrWsConnection, RelayMessage, WsClientError};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_state::AppState;

/// Overall budget for one control request/reply exchange.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-receive budget inside the exchange loop.
const RECV_TIMEOUT: Duration = Duration::from_secs(10);

/// A discovered agent host, shaped for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostInfo {
    /// The host daemon's pubkey (hex) — control-frame recipient and TOFU pin.
    pub host_pubkey: String,
    /// Stable host id (announcement `d` tag).
    pub host_id: String,
    /// Human-readable label.
    pub label: String,
    /// Daemon version.
    pub version: String,
    /// Launchable runtimes advertised by the host.
    pub runtimes: Vec<AgentHostRuntime>,
    /// Maximum agents the host will supervise.
    pub max_agents: u32,
    /// Agents currently deployed on the host.
    pub deployed: u32,
    /// Whether the user has accepted this host's pubkey (TOFU).
    pub accepted: bool,
}

/// One runtime advertised by a host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHostRuntime {
    /// Runtime id (named in control frames).
    pub id: String,
    /// Human-readable label.
    pub label: String,
}

// ── TOFU accepted-hosts store ────────────────────────────────────────────

fn accepted_hosts_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(super::storage::managed_agents_base_dir(app)?.join("accepted-hosts.json"))
}

/// Hex pubkeys of hosts the user has explicitly accepted.
pub fn load_accepted_hosts(app: &AppHandle) -> Vec<String> {
    let Ok(path) = accepted_hosts_path(app) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist acceptance of a host pubkey (idempotent).
pub fn accept_host(app: &AppHandle, host_pubkey: &str) -> Result<(), String> {
    nostr::PublicKey::from_hex(host_pubkey).map_err(|e| format!("invalid host pubkey: {e}"))?;
    let mut accepted = load_accepted_hosts(app);
    let normalized = host_pubkey.to_lowercase();
    if !accepted.contains(&normalized) {
        accepted.push(normalized);
    }
    let json = serde_json::to_string_pretty(&accepted)
        .map_err(|e| format!("serialize accepted hosts: {e}"))?;
    std::fs::write(accepted_hosts_path(app)?, json)
        .map_err(|e| format!("write accepted hosts: {e}"))
}

/// True when the host pubkey has been explicitly accepted.
pub fn host_is_accepted(app: &AppHandle, host_pubkey: &str) -> bool {
    load_accepted_hosts(app)
        .iter()
        .any(|p| p.eq_ignore_ascii_case(host_pubkey))
}

// ── Discovery ────────────────────────────────────────────────────────────

/// Query the relay for kind 30178 host announcements.
pub async fn discover_hosts(
    app: &AppHandle,
    state: &AppState,
) -> Result<Vec<AgentHostInfo>, String> {
    let relay_url = crate::relay::relay_ws_url_with_override(state);
    let base = crate::relay::relay_http_base_url(&relay_url);
    let filter = serde_json::json!({
        "kinds": [buzz_core_pkg::kind::KIND_AGENT_HOST_ANNOUNCE],
    });
    let events = crate::relay::query_relay_at(state, &base, &[filter]).await?;
    let accepted = load_accepted_hosts(app);
    let mut hosts: Vec<AgentHostInfo> = events
        .iter()
        .filter_map(|event| parse_host_announcement(event).ok())
        .map(|announcement| {
            let host_pubkey = announcement.host_pubkey.to_hex();
            let accepted = accepted
                .iter()
                .any(|p| p.eq_ignore_ascii_case(&host_pubkey));
            AgentHostInfo {
                host_pubkey,
                host_id: announcement.host_id,
                label: announcement.content.label,
                version: announcement.content.version,
                runtimes: announcement
                    .content
                    .runtimes
                    .into_iter()
                    .map(|r| AgentHostRuntime {
                        id: r.id,
                        label: r.label,
                    })
                    .collect(),
                max_agents: announcement.content.capacity.max_agents,
                deployed: announcement.content.capacity.deployed,
                accepted,
            }
        })
        .collect();
    hosts.sort_by(|a, b| {
        a.label
            .cmp(&b.label)
            .then(a.host_pubkey.cmp(&b.host_pubkey))
    });
    Ok(hosts)
}

// ── Control exchange ─────────────────────────────────────────────────────

/// Send one control request to a host and await its correlated reply.
///
/// Opens a short-lived NIP-42 connection as the owner, subscribes for the
/// reply (`#p` = owner, which the relay's p-gate requires anyway), then
/// publishes the request. Ephemeral frames are never stored, so the
/// subscription must be open before the request goes out.
pub async fn control_exchange(
    state: &AppState,
    host_pubkey_hex: &str,
    request: &HostControlRequest,
) -> Result<HostControlReply, String> {
    let owner_keys = state.signing_keys()?;
    let relay_url = crate::relay::relay_ws_url_with_override(state);
    let host_pubkey = nostr::PublicKey::from_hex(host_pubkey_hex)
        .map_err(|e| format!("invalid host pubkey: {e}"))?;
    let req_id = uuid::Uuid::new_v4().to_string();

    let exchange = async {
        let mut conn = NostrWsConnection::connect_authenticated(&relay_url, &owner_keys, None)
            .await
            .map_err(|e| format!("relay connection failed: {e}"))?;

        let owner_hex = owner_keys.public_key().to_hex();
        conn.send_raw(&serde_json::json!([
            "REQ",
            "hostreply",
            {
                "kinds": [buzz_core_pkg::kind::KIND_AGENT_HOST_CONTROL],
                "#p": [owner_hex]
            }
        ]))
        .await
        .map_err(|e| format!("reply subscription failed: {e}"))?;

        let event =
            buzz_sdk_pkg::host::build_control_request(&owner_keys, &host_pubkey, &req_id, request)
                .map_err(|e| format!("build control request: {e}"))?
                .sign_with_keys(&owner_keys)
                .map_err(|e| format!("sign control request: {e}"))?;

        let ok = conn
            .send_event(event)
            .await
            .map_err(|e| format!("publish control request: {e}"))?;
        if !ok.accepted {
            return Err(format!("relay rejected control request: {}", ok.message));
        }

        loop {
            match conn.next_event(RECV_TIMEOUT).await {
                Ok(RelayMessage::Event { event, .. }) => {
                    let Ok(meta) = control_frame_meta(&event) else {
                        continue;
                    };
                    if meta.direction != ControlFrameDirection::Reply
                        || meta.req_id != req_id
                        || meta.host_pubkey != host_pubkey
                        || event.pubkey != host_pubkey
                    {
                        continue;
                    }
                    let reply = decrypt_control_reply(&owner_keys, &event)
                        .map_err(|e| format!("decrypt host reply: {e}"))?;
                    let _ = conn.disconnect().await;
                    return Ok(reply);
                }
                Ok(_) => continue,
                Err(WsClientError::Timeout) => continue,
                Err(e) => return Err(format!("relay connection lost awaiting reply: {e}")),
            }
        }
    };

    let reply = tokio::time::timeout(EXCHANGE_TIMEOUT, exchange)
        .await
        .map_err(|_| {
            "host did not reply within 30s — is the daemon running and a community member?"
                .to_string()
        })??;

    if let HostControlReply::Error { message } = &reply {
        return Err(format!("host rejected the request: {message}"));
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_info_serializes_camel_case_for_frontend() {
        let info = AgentHostInfo {
            host_pubkey: "aa".into(),
            host_id: "gradient".into(),
            label: "gradient".into(),
            version: "0.1.0".into(),
            runtimes: vec![AgentHostRuntime {
                id: "claude".into(),
                label: "Claude Code".into(),
            }],
            max_agents: 32,
            deployed: 1,
            accepted: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("hostPubkey"));
        assert!(json.contains("maxAgents"));
    }
}
