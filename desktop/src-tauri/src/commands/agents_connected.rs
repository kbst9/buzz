//! Commands for CONNECTED agents — standalone identities running their own
//! harness on another host. The desktop holds no `ManagedAgentRecord` and no
//! key for them; everything here is owner-signed and rides the same
//! retention flush pipe as managed-agent events.

use tauri::{AppHandle, Manager, State};

use crate::{
    app_state::AppState,
    managed_agents::{
        load_managed_agents, managed_agents_base_dir, reconcile::retain_connected_agent_definition,
        retention::open_retention_db,
    },
    relay::{submit_event, SubmitEventResponse},
};

/// Publish (or update) a connected agent's owner-authored kind:30177
/// definition — the save path behind the Connected Agents Instructions
/// editor.
///
/// The owner asserts a display label and instructions; buzz-acp on the
/// agent's host reads the definition's `system_prompt` into its `[System]`
/// prompt section at each new session birth, so edits here reach the agent
/// without touching the host. Whitespace-only instructions publish a
/// definition without a prompt — the harness treats confirmed absence as an
/// explicit clear.
///
/// The write goes through the shared retention engine
/// (`retain_connected_agent_definition`): content-diff suppression, a
/// monotonic `created_at` bump past the retained head, and the 30s flush
/// loop as the sole publisher.
#[tauri::command]
pub async fn set_connected_agent_instructions(
    agent_pubkey: String,
    agent_name: String,
    instructions: String,
    app: AppHandle,
) -> Result<(), String> {
    // Normalize + validate: the d-tag must be the agent's 64-hex pubkey.
    let agent_pubkey = nostr::PublicKey::from_hex(agent_pubkey.trim())
        .map_err(|e| format!("agent pubkey must be 64-hex: {e}"))?
        .to_hex();
    let agent_name = agent_name.trim().to_string();
    if agent_name.is_empty() {
        return Err("agent name must not be empty".to_string());
    }
    let system_prompt = {
        let trimmed = instructions.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };

    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        // A managed agent's 30177 is owned by its record via the boot-time
        // reconcile — an out-of-band write here would be overwritten on the
        // next boot and desync the Agents tab. Route those edits through the
        // managed-agent editor instead.
        if load_managed_agents(&app)?
            .iter()
            .any(|record| record.pubkey == agent_pubkey)
        {
            return Err(
                "this agent is managed by this desktop — edit it in the Agents tab".to_string(),
            );
        }
        let conn = open_retention_db(&managed_agents_base_dir(&app)?.join("retention.db"))?;
        let keys = state.signing_keys()?;
        retain_connected_agent_definition(&conn, &keys, &agent_pubkey, &agent_name, system_prompt)
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Publish (or update) an owner-authored kind:30978 SWARM definition — the
/// save path behind the Swarms section's create/edit dialog.
///
/// `content_json` is the serialized swarm content (buzz-sdk `SwarmContent`
/// field names); `swarm_id` is the stable d-tag. The event is signed with
/// the active identity and submitted through the shared relay submit path,
/// so the leader's harness picks the definition up at its next session —
/// no agent participation needed, works while the leader is offline.
#[tauri::command]
pub async fn publish_swarm_definition(
    swarm_id: String,
    content_json: String,
    state: State<'_, AppState>,
) -> Result<SubmitEventResponse, String> {
    let content = buzz_sdk_pkg::swarm::parse_swarm_content(&content_json)?;
    let builder = buzz_sdk_pkg::swarm::build_swarm_definition(swarm_id.trim(), &content)?;
    submit_event(builder, &state).await
}
