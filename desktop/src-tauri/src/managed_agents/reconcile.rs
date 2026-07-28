//! Boot-time disk↔relay reconcile for managed-agent (kind:30177) events.
//!
//! `run_event_sync` already reconciles personas (30175) and teams (30176)
//! into the retention store at boot; managed agents were the missing leg —
//! their events were enqueued only on the interactive save path
//! (`retain_managed_agent_pending`), so a record edited on disk between
//! launches, or a save whose publish was missed, silently diverged from the
//! relay. This module mirrors `migrate_personas_in_dir`: per-coordinate
//! content diff, monotonic `created_at` bump, retain with `pending_sync = 1`
//! for the existing flush loop.
//!
//! Best-effort contract (decided in #centralize-personas-and-agents):
//! - No file watcher — hand edits are picked up at next boot only.
//! - No deletion reconcile — a record absent from `managed-agents.json` is
//!   left untouched in retention; a truncated or partial file must never
//!   trigger tombstones.
//! - A malformed store fails loudly: the broken file is preserved as
//!   `managed-agents.json.invalid` (see [`super::storage::backup_invalid_store`])
//!   and an error is returned, never silently skipped.

use std::path::Path;

use super::{
    agent_events::build_agent_event,
    persona_events::monotonic_created_at,
    retention::{get_retained_event, open_retention_db, retain_event, RetainedEvent},
    ManagedAgentRecord,
};
use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
use nostr::JsonUtil;

/// Reconcile `managed-agents.json` into kind:30177 events in the retention
/// store. Boot-time entry point, called from `event_sync::run_event_sync`
/// after the persona and team legs.
pub(crate) fn reconcile_agents_to_events(app: &tauri::AppHandle, keys: &nostr::Keys) {
    let Ok(base_dir) = super::managed_agents_base_dir(app) else {
        return;
    };

    match reconcile_agents_in_dir(&base_dir, keys) {
        Ok(0) => {}
        Ok(reconciled) => {
            eprintln!(
                "buzz-desktop: agent-event-reconcile: {reconciled} agents reconciled to retention"
            );
        }
        Err(e) => {
            eprintln!("buzz-desktop: agent-event-reconcile: {e}");
        }
    }
}

/// Core reconcile logic, decoupled from the Tauri `AppHandle` for testing.
///
/// Reads `managed-agents.json` raw — no keyring hydration: the published
/// projection ([`super::agent_events::agent_event_content`]) is the opt-IN
/// no-secrets allowlist, so keys are never needed here. For each record it
/// compares the freshly built event's content against the retained row at
/// `(30177, owner, agent_pubkey)` and re-retains (marking `pending_sync = 1`)
/// only when the row is absent or its content differs — an unchanged agent
/// never churns `pending_sync`.
///
/// Returns the number of agents (re)written to the retention store.
pub(crate) fn reconcile_agents_in_dir(base_dir: &Path, keys: &nostr::Keys) -> Result<u32, String> {
    let store_path = base_dir.join("managed-agents.json");
    if !store_path.exists() {
        return Ok(0);
    }

    let content = std::fs::read_to_string(&store_path)
        .map_err(|e| format!("failed to read managed-agents.json: {e}"))?;

    let records: Vec<ManagedAgentRecord> = serde_json::from_str(&content).map_err(|e| {
        super::storage::backup_invalid_store(&store_path);
        format!("failed to parse managed-agents.json (preserved as .invalid): {e}")
    })?;

    if records.is_empty() {
        return Ok(0);
    }

    let db_path = base_dir.join("retention.db");
    let conn =
        open_retention_db(&db_path).map_err(|e| format!("failed to open retention db: {e}"))?;

    let mut reconciled = 0u32;

    for record in &records {
        // A record without a pubkey has no event coordinate yet (key-less
        // agents mint keys on first start) — nothing to reconcile.
        if record.pubkey.is_empty() {
            continue;
        }

        if retain_agent_record(&conn, keys, record)? {
            reconciled += 1;
        }
    }

    Ok(reconciled)
}

/// Retain `record`'s kind:30177 identity record, marking it `pending_sync`
/// for the flush loop, when its projection differs from the retained head.
/// Returns `Ok(true)` when a row was (re)written and `Ok(false)` when the
/// retained content already matches (a true no-op — no `pending_sync` churn).
///
/// This is the single content-diff + monotonic-bump engine shared by the
/// boot-time reconcile above and the interactive edit paths
/// (`retain_managed_agent_pending`, persona-rename propagation). Every
/// mutation of an agent's published identity must go through it so the
/// retained record can never silently drift from `managed-agents.json`.
pub(crate) fn retain_agent_record(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    record: &ManagedAgentRecord,
) -> Result<bool, String> {
    retain_definition_head(
        conn,
        keys,
        &record.pubkey,
        build_agent_event(record)?,
        &record.name,
    )
}

/// Retain a connected agent's kind:30177 definition from owner-asserted
/// fields — the interactive path behind the Connected Agents Instructions
/// editor. Same coordinate scheme as managed records (`d_tag` = agent
/// pubkey), same diff + bump engine, no `ManagedAgentRecord` involved.
pub(crate) fn retain_connected_agent_definition(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    agent_pubkey: &str,
    name: &str,
    system_prompt: Option<String>,
) -> Result<bool, String> {
    retain_definition_head(
        conn,
        keys,
        agent_pubkey,
        super::agent_events::build_connected_agent_event(agent_pubkey, name, system_prompt)?,
        name,
    )
}

/// Shared diff + monotonic-bump engine for kind:30177 heads.
///
/// Builds the event first and compares ITS content, so the comparison and
/// the retained row share one serialization of the projection (mirrors
/// `migrate_personas_in_dir`). Serializing the projection independently
/// here would silently diverge if the builder ever changed how it
/// serializes — republishing every agent every boot. Content is
/// timestamp-independent, so the monotonic bump below never forces a
/// spurious republish; an unchanged agent is still a true no-op.
fn retain_definition_head(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    d_tag: &str,
    builder: nostr::EventBuilder,
    label: &str,
) -> Result<bool, String> {
    let owner_pubkey = keys.public_key().to_hex();
    let existing = get_retained_event(conn, KIND_MANAGED_AGENT, &owner_pubkey, d_tag)?;

    let event = builder
        .custom_created_at(monotonic_created_at(
            existing.as_ref().map(|row| row.created_at),
        ))
        .sign_with_keys(keys)
        .map_err(|e| format!("failed to sign event for '{label}': {e}"))?;

    let content = event.content.clone();
    if existing.as_ref().is_some_and(|row| row.content == content) {
        return Ok(false);
    }

    retain_event(
        conn,
        &RetainedEvent {
            kind: KIND_MANAGED_AGENT,
            pubkey: owner_pubkey,
            d_tag: d_tag.to_string(),
            content,
            created_at: event.created_at.as_secs() as i64,
            raw_event: event.as_json(),
            pending_sync: true,
        },
    )
    .map_err(|e| format!("failed to retain '{label}': {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests;
