//! Tauri commands for `BackendKind::Host` agents — remote agents supervised
//! by a `buzz-agent-host` daemon and controlled over the relay.
//!
//! Lifecycle mapping (all ops ride kind 24300 control frames signed with
//! the owner key; see `managed_agents::host_backend`):
//!
//! - create → `create` (host generates the keypair, returns the pubkey)
//!   then `grant` (owner mints the NIP-OA auth tag for that pubkey)
//! - edit instructions/model/env → `configure`
//! - start / stop → `start` / `stop`
//! - delete → `remove` (via [`remove_host_agent_remote`], then the regular
//!   `delete_managed_agent` with `force_remote_delete`)
//! - logs → `logs`
//!
//! Records with this backend never hold a private key: the agent identity
//! lives on the host, and only its pubkey and the owner-minted auth tag
//! exist locally.

use std::collections::BTreeMap;

use buzz_core_pkg::host::{HostAgentConfig, HostControlReply, HostControlRequest};
use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    managed_agents::host_backend::{
        accept_host, control_exchange, discover_hosts, host_is_accepted, AgentHostInfo,
    },
    managed_agents::{
        build_managed_agent_summary, find_managed_agent_mut, load_managed_agents, load_personas,
        save_managed_agents, BackendKind, ManagedAgentRecord, ManagedAgentSummary,
        DEFAULT_ACP_COMMAND, DEFAULT_AGENT_TURN_TIMEOUT_SECONDS,
    },
    util::now_iso,
};

use super::agents::retain_managed_agent_pending;

/// List agent hosts announced on the active relay (kind 30178).
#[tauri::command]
pub async fn discover_agent_hosts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AgentHostInfo>, String> {
    discover_hosts(&app, &state).await
}

/// Record the user's explicit acceptance of a host pubkey (TOFU pin).
#[tauri::command]
pub async fn accept_agent_host(host_pubkey: String, app: AppHandle) -> Result<(), String> {
    accept_host(&app, &host_pubkey)
}

/// Request payload for [`create_host_agent`].
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateHostAgentRequest {
    /// The chosen host's pubkey (hex). Must be TOFU-accepted.
    pub host_pubkey: String,
    /// Runtime id from the host's announcement.
    pub runtime: String,
    /// Agent display name.
    pub name: String,
    #[serde(default)]
    pub persona_id: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub env_vars: BTreeMap<String, String>,
}

/// Build the host-side agent config from a record's authoritative fields.
fn host_config_for_record(record: &ManagedAgentRecord) -> Result<HostAgentConfig, String> {
    let BackendKind::Host { ref runtime, .. } = record.backend else {
        return Err(format!("agent {} is not host-backed", record.pubkey));
    };
    Ok(HostAgentConfig {
        label: record.name.clone(),
        runtime: runtime.clone(),
        system_prompt: record.system_prompt.clone(),
        model: record.model.clone(),
        provider: record.provider.clone(),
        env: record.env_vars.clone(),
    })
}

/// Resolve a host-backed record's host pubkey.
fn host_pubkey_of(record: &ManagedAgentRecord) -> Result<String, String> {
    match &record.backend {
        BackendKind::Host { host_pubkey, .. } => Ok(host_pubkey.clone()),
        _ => Err(format!("agent {} is not host-backed", record.pubkey)),
    }
}

/// Create an agent on a remote host: `create` (host generates the keypair),
/// mint the NIP-OA auth tag for the returned pubkey, `grant`, then persist
/// the local record. The record carries no private key.
#[tauri::command]
pub async fn create_host_agent(
    input: CreateHostAgentRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ManagedAgentSummary, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("agent name is required".to_string());
    }
    if !host_is_accepted(&app, &input.host_pubkey) {
        return Err(
            "this host has not been accepted yet — review its pubkey and accept it first"
                .to_string(),
        );
    }
    crate::managed_agents::validate_user_env_keys(&input.env_vars)?;

    let config = HostAgentConfig {
        label: name.clone(),
        runtime: input.runtime.clone(),
        system_prompt: input
            .system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        model: input.model.clone().filter(|m| !m.trim().is_empty()),
        provider: input.provider.clone().filter(|p| !p.trim().is_empty()),
        env: input.env_vars.clone(),
    };

    // ── create: the host generates the agent identity ────────────────────
    let reply = control_exchange(
        &state,
        &input.host_pubkey,
        &HostControlRequest::Create { config },
    )
    .await?;
    let HostControlReply::Created {
        agent: agent_pubkey,
    } = reply
    else {
        return Err(format!("unexpected host reply to create: {reply:?}"));
    };

    // ── grant: mint the owner attestation for the host-generated pubkey ──
    let auth_tag = {
        let owner_keys = state.signing_keys()?;
        let agent_pk = nostr::PublicKey::from_hex(&agent_pubkey)
            .map_err(|e| format!("host returned an invalid agent pubkey: {e}"))?;
        buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_keys, &agent_pk, "")
            .map_err(|e| format!("failed to compute NIP-OA auth tag: {e}"))?
    };
    control_exchange(
        &state,
        &input.host_pubkey,
        &HostControlRequest::Grant {
            agent: agent_pubkey.clone(),
            auth_tag: auth_tag.clone(),
        },
    )
    .await?;

    // ── persist the local record (no key material) ───────────────────────
    let now = now_iso();
    let record = ManagedAgentRecord {
        pubkey: agent_pubkey.clone(),
        name,
        persona_id: input.persona_id.clone(),
        team_id: None,
        private_key_nsec: String::new(),
        auth_tag: Some(auth_tag),
        relay_url: String::new(),
        avatar_url: None,
        acp_command: DEFAULT_ACP_COMMAND.to_string(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: Vec::new(),
        mcp_command: String::new(),
        turn_timeout_seconds: DEFAULT_AGENT_TURN_TIMEOUT_SECONDS,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: crate::managed_agents::DEFAULT_AGENT_PARALLELISM,
        system_prompt: input.system_prompt.filter(|s| !s.trim().is_empty()),
        model: input.model,
        provider: input.provider,
        persona_source_version: None,
        env_vars: input.env_vars,
        start_on_app_launch: false,
        auto_restart_on_config_change: false,
        runtime_pid: None,
        backend: BackendKind::Host {
            host_pubkey: input.host_pubkey.to_lowercase(),
            runtime: input.runtime,
        },
        backend_agent_id: Some(agent_pubkey.clone()),
        provider_binary_path: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        last_started_at: Some(now),
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: Default::default(),
        respond_to_allowlist: Vec::new(),
        display_name: None,
        slug: None,
        runtime: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        source_team: None,
        source_team_persona_slug: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Vec::new(),
        definition_parallelism: None,
        relay_mesh: None,
    };

    let summary = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(&app)?;
        if records.iter().any(|r| r.pubkey == record.pubkey) {
            return Err(format!("agent {} already exists", record.pubkey));
        }
        records.push(record.clone());
        save_managed_agents(&app, &records)?;
        retain_managed_agent_pending(&app, &state, &record);

        let runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let personas = load_personas(&app).unwrap_or_default();
        build_managed_agent_summary(
            &app,
            &record,
            &runtimes,
            &personas,
            &crate::managed_agents::load_global_agent_config(&app).unwrap_or_default(),
        )?
    };
    Ok(summary)
}

/// Shared body for start/stop: run the op, then stamp the record.
async fn host_lifecycle_op(
    pubkey: &str,
    app: &AppHandle,
    state: &AppState,
    request_for: impl FnOnce(String) -> HostControlRequest,
    started: bool,
) -> Result<ManagedAgentSummary, String> {
    let host_pubkey = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(app)?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;
        host_pubkey_of(record)?
    };

    control_exchange(state, &host_pubkey, &request_for(pubkey.to_string())).await?;

    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(app)?;
    {
        let record = find_managed_agent_mut(&mut records, pubkey)?;
        record.updated_at = now_iso();
        if started {
            record.last_started_at = Some(now_iso());
        } else {
            record.last_stopped_at = Some(now_iso());
        }
        record.last_error = None;
    }
    save_managed_agents(app, &records)?;
    let record = records
        .iter()
        .find(|r| r.pubkey == pubkey)
        .ok_or_else(|| format!("agent {pubkey} not found"))?;
    let runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let personas = load_personas(app).unwrap_or_default();
    build_managed_agent_summary(
        app,
        record,
        &runtimes,
        &personas,
        &crate::managed_agents::load_global_agent_config(app).unwrap_or_default(),
    )
}

/// Start a host-backed agent on its host.
#[tauri::command]
pub async fn start_host_agent(
    pubkey: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ManagedAgentSummary, String> {
    host_lifecycle_op(
        &pubkey,
        &app,
        &state,
        |agent| HostControlRequest::Start { agent },
        true,
    )
    .await
}

/// Stop a host-backed agent on its host.
#[tauri::command]
pub async fn stop_host_agent(
    pubkey: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ManagedAgentSummary, String> {
    host_lifecycle_op(
        &pubkey,
        &app,
        &state,
        |agent| HostControlRequest::Stop { agent },
        false,
    )
    .await
}

/// Push the record's current configuration to the host (`configure`). The
/// host rewrites the agent's env wholesale and restarts it if running —
/// this is how instruction/model/env edits reach a remote agent.
#[tauri::command]
pub async fn configure_host_agent(
    pubkey: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (host_pubkey, config) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(&app)?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;
        (host_pubkey_of(record)?, host_config_for_record(record)?)
    };
    control_exchange(
        &state,
        &host_pubkey,
        &HostControlRequest::Configure {
            agent: pubkey,
            config,
        },
    )
    .await?;
    Ok(())
}

/// Remove the agent from its host (stops it and deletes host-side state,
/// including the agent's key). Call before `delete_managed_agent` with
/// `force_remote_delete: true` to also drop the local record.
#[tauri::command]
pub async fn remove_host_agent_remote(
    pubkey: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let host_pubkey = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(&app)?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;
        host_pubkey_of(record)?
    };
    control_exchange(
        &state,
        &host_pubkey,
        &HostControlRequest::Remove { agent: pubkey },
    )
    .await?;
    Ok(())
}

/// Fetch a bounded log tail from the agent's host.
#[tauri::command]
pub async fn host_agent_logs(
    pubkey: String,
    lines: Option<u32>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let host_pubkey = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let records = load_managed_agents(&app)?;
        let record = records
            .iter()
            .find(|r| r.pubkey == pubkey)
            .ok_or_else(|| format!("agent {pubkey} not found"))?;
        host_pubkey_of(record)?
    };
    let reply = control_exchange(
        &state,
        &host_pubkey,
        &HostControlRequest::Logs {
            agent: pubkey,
            lines: lines.unwrap_or(200),
        },
    )
    .await?;
    match reply {
        HostControlReply::Logs { lines, .. } => Ok(lines),
        other => Err(format!("unexpected host reply to logs: {other:?}")),
    }
}
