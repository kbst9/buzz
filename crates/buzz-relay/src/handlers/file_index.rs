//! Relay-derived NIP-94 file index — live emitter and retraction cascades.
//!
//! Every accepted channel event carrying valid `imeta` attachments yields
//! relay-signed kind-1063 index entries (one per attachment); edits
//! reconcile the entry set; deletions and moderation removals cascade as
//! relay-signed kind-5 retractions. Derivation is shared with
//! `buzz-admin files backfill` via [`buzz_core::file_index`].
//!
//! Emission is spawned post-accept (never on the ingest ack path) and is
//! deliberately trigger-neutral: index inserts always ride alongside the
//! organic insert that just refreshed any ephemeral-channel TTL, carry no
//! `p` tags for the push matcher, and use emission-time `created_at` for
//! replica-fence safety. Full analysis: `docs/channel-files-explorer.md`.

use std::collections::HashSet;
use std::sync::Arc;

use nostr::{Event, EventBuilder, Kind, Tag};
use tracing::warn;
use uuid::Uuid;

use buzz_core::file_index::{derive_file_index_specs, imeta_hash_set, parse_imeta_entries};
use buzz_core::kind::{KIND_DELETION, KIND_FILE_METADATA, KIND_STREAM_MESSAGE_EDIT};
use buzz_core::tenant::TenantContext;
use buzz_core::StoredEvent;
use buzz_db::channel::ChannelType;
use buzz_pubsub::EventTopic;

use crate::state::AppState;

/// Route a freshly ingested channel event into the file index.
///
/// The single hook site in `ingest_event`; all gating lives here. Runs only
/// for events that were actually inserted (the caller dispatches side
/// effects exactly once per stored event), so no idempotency check is
/// needed on this path.
pub(crate) fn dispatch_from_ingest(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
    kind_u32: u32,
    channel_id: Option<Uuid>,
) {
    if !state.config.file_index_enabled {
        return;
    }
    let Some(channel_id) = channel_id else {
        return;
    };
    if kind_u32 == KIND_FILE_METADATA || kind_u32 == KIND_DELETION {
        return;
    }

    if kind_u32 == KIND_STREAM_MESSAGE_EDIT {
        // Edits reconcile even when the new imeta set is empty — that is
        // exactly the attachment-removal case.
        let tenant = tenant.clone();
        let state = Arc::clone(state);
        let event = event.clone();
        tokio::spawn(async move {
            reconcile_edit(&tenant, &state, &event, channel_id).await;
        });
        return;
    }

    if parse_imeta_entries(event).is_empty() {
        return;
    }
    let tenant = tenant.clone();
    let state = Arc::clone(state);
    let event = event.clone();
    tokio::spawn(async move {
        emit_for_message(&tenant, &state, &event, channel_id).await;
    });
}

/// Cascade-retract all index entries referencing `target_id` after the
/// target was deleted (NIP-09 kind 5) or moderation-removed (kind 9005).
///
/// Deliberately not gated on `file_index_enabled`: entries created while
/// the flag was on must still be cleaned up after it is turned off.
pub(crate) fn spawn_cascade_retract(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    target_id: Vec<u8>,
    channel_id: Option<Uuid>,
) {
    let tenant = tenant.clone();
    let state = Arc::clone(state);
    tokio::spawn(async move {
        let target_hex = hex::encode(&target_id);
        let existing = match state
            .db
            .get_events_by_kind_and_e_tag(tenant.community(), KIND_FILE_METADATA as i32, &target_hex)
            .await
        {
            Ok(events) => events,
            Err(e) => {
                warn!(target = %target_hex, "file index cascade lookup failed: {e}");
                return;
            }
        };
        retract_entries(&tenant, &state, &existing, channel_id).await;
    });
}

/// True when the channel should be indexed. DMs are excluded by design
/// (their attachments must not surface in relay-signed community-readable
/// events); lookup failures fail closed.
async fn is_indexable_channel(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    channel_id: Uuid,
) -> bool {
    match state.db.get_channel(tenant.community(), channel_id).await {
        // `ChannelRecord.channel_type` is the raw DB string; compare against
        // the enum's canonical form rather than a literal.
        Ok(record) => record.channel_type != ChannelType::Dm.as_str(),
        Err(e) => {
            warn!(channel = %channel_id, "file index channel lookup failed: {e}");
            false
        }
    }
}

async fn emit_for_message(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    source: &Event,
    channel_id: Uuid,
) {
    if !is_indexable_channel(tenant, state, channel_id).await {
        return;
    }
    let uploader = hex::encode(super::ingest::effective_message_author(
        source,
        &state.relay_keypair.public_key(),
    ));
    let specs = derive_file_index_specs(
        source,
        &uploader,
        &source.id.to_hex(),
        source.created_at.as_secs(),
        &channel_id.to_string(),
    );
    emit_specs(tenant, state, specs, channel_id).await;
}

/// Reconcile the index after a kind-40003 edit: entries whose hash left the
/// edit's imeta set are retracted, hashes new to it are emitted. The
/// `(e, x)` identity keys on the *edited target's* id, so entries stay
/// stable across edit chains and the existing-entry set is the diff basis.
async fn reconcile_edit(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    edit: &Event,
    channel_id: Uuid,
) {
    if !is_indexable_channel(tenant, state, channel_id).await {
        return;
    }
    let Some(target_hex) = first_e_tag_hex(edit) else {
        return;
    };

    let existing = match state
        .db
        .get_events_by_kind_and_e_tag(tenant.community(), KIND_FILE_METADATA as i32, &target_hex)
        .await
    {
        Ok(events) => events,
        Err(e) => {
            warn!(target = %target_hex, "file index edit lookup failed: {e}");
            return;
        }
    };

    let keep = imeta_hash_set(edit);
    let (kept, removed): (Vec<&StoredEvent>, Vec<&StoredEvent>) = existing
        .iter()
        .partition(|entry| x_tag_value(&entry.event).is_some_and(|x| keep.contains(&x)));

    let removed: Vec<StoredEvent> = removed.into_iter().cloned().collect();
    retract_entries(tenant, state, &removed, Some(channel_id)).await;

    let have: HashSet<String> = kept
        .iter()
        .filter_map(|entry| x_tag_value(&entry.event))
        .collect();
    let uploader = hex::encode(super::ingest::effective_message_author(
        edit,
        &state.relay_keypair.public_key(),
    ));
    let specs: Vec<_> = derive_file_index_specs(
        edit,
        &uploader,
        &target_hex,
        edit.created_at.as_secs(),
        &channel_id.to_string(),
    )
    .into_iter()
    .filter(|spec| !have.contains(&spec.sha256))
    .collect();
    emit_specs(tenant, state, specs, channel_id).await;
}

/// Sign, store, and fan out derived index events. Best-effort per entry,
/// mirroring `emit_system_message`.
async fn emit_specs(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    specs: Vec<buzz_core::file_index::FileIndexSpec>,
    channel_id: Uuid,
) {
    for spec in specs {
        let event = match EventBuilder::new(Kind::Custom(KIND_FILE_METADATA as u16), spec.content)
            .tags(spec.tags)
            .sign_with_keys(&state.relay_keypair)
        {
            Ok(event) => event,
            Err(e) => {
                warn!(channel = %channel_id, "file index sign failed: {e}");
                continue;
            }
        };
        if let Err(e) = state
            .db
            .insert_event(tenant.community(), &event, Some(channel_id))
            .await
        {
            warn!(channel = %channel_id, "file index insert failed: {e}");
            continue;
        }
        if let Err(e) = state
            .pubsub
            .publish_event(tenant, EventTopic::Channel(channel_id), &event)
            .await
        {
            warn!(channel = %channel_id, "file index fan-out failed: {e}");
        }
    }
}

/// Soft-delete `victims` and announce them in one relay-signed kind-5
/// (tagged `k 1063` so clients can route it cheaply). The relay authored
/// the entries, so it may delete them; the internal insert path skips
/// ingest-side deletion validation, and the target soft-deletes are done
/// here directly rather than relying on the kind-5 side-effect handler.
async fn retract_entries(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    victims: &[StoredEvent],
    channel_id: Option<Uuid>,
) {
    if victims.is_empty() {
        return;
    }

    let mut deleted_hex = Vec::with_capacity(victims.len());
    for victim in victims {
        let id = victim.event.id;
        match state
            .db
            .soft_delete_event(tenant.community(), id.as_bytes())
            .await
        {
            Ok(true) => deleted_hex.push(id.to_hex()),
            Ok(false) => {}
            Err(e) => {
                warn!(entry = %id.to_hex(), "file index soft delete failed: {e}");
            }
        }
    }
    if deleted_hex.is_empty() {
        return;
    }

    let mut raw: Vec<Vec<String>> = deleted_hex
        .iter()
        .map(|id| vec!["e".to_string(), id.clone()])
        .collect();
    raw.push(vec!["k".to_string(), KIND_FILE_METADATA.to_string()]);
    if let Some(channel_id) = channel_id {
        raw.push(vec!["h".to_string(), channel_id.to_string()]);
    }
    let mut tags = Vec::with_capacity(raw.len());
    for parts in &raw {
        match Tag::parse(parts.iter().map(String::as_str)) {
            Ok(tag) => tags.push(tag),
            Err(e) => {
                warn!("file index retraction tag failed: {e}");
                return;
            }
        }
    }

    let event = match EventBuilder::new(
        Kind::Custom(KIND_DELETION as u16),
        "file index retraction",
    )
    .tags(tags)
    .sign_with_keys(&state.relay_keypair)
    {
        Ok(event) => event,
        Err(e) => {
            warn!("file index retraction sign failed: {e}");
            return;
        }
    };
    if let Err(e) = state
        .db
        .insert_event(tenant.community(), &event, channel_id)
        .await
    {
        warn!("file index retraction insert failed: {e}");
        return;
    }
    if let Some(channel_id) = channel_id {
        if let Err(e) = state
            .pubsub
            .publish_event(tenant, EventTopic::Channel(channel_id), &event)
            .await
        {
            warn!("file index retraction fan-out failed: {e}");
        }
    }
}

/// First well-formed `e` tag value — the edit-target convention shared with
/// `validate_edit_ownership`.
fn first_e_tag_hex(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        let parts = t.as_slice();
        if parts.first().map(String::as_str) != Some("e") {
            return None;
        }
        parts
            .get(1)
            .filter(|v| v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|v| v.to_string())
    })
}

/// The `x` tag value of a stored index entry.
fn x_tag_value(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        let parts = t.as_slice();
        (parts.first().map(String::as_str) == Some("x"))
            .then(|| parts.get(1).map(|v| v.to_string()))
            .flatten()
    })
}
