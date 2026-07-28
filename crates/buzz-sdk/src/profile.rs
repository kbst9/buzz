//! kind:0 profile merging — generic preservation, plus the agent guarantee.
//!
//! kind:0 is replaceable: every publish replaces the whole profile, so any
//! writer that rebuilds it from the fields it happens to know about silently
//! drops the rest. Two things make that dangerous in Buzz:
//!
//! - unknown content fields (`lud16`, custom keys) vanish on every edit;
//! - for agents, the NIP-OA `auth` tag lives *inside* the profile — dropping
//!   it orphans the agent for every client-side classifier (relay-side
//!   ownership survives via first-write-wins, which makes the breakage
//!   quiet and confusing rather than loud).
//!
//! Every profile writer in this workspace goes through [`merge_profile`]
//! (preserve everything, overlay only what was asked), and every *agent*
//! profile writer through [`merge_agent_profile`] (same, plus `bot: true`
//! and a verified auth tag, or a refusal). Preservation is structural, not
//! disciplinary.

use nostr::{Event, EventBuilder, Kind, PublicKey, Tag};
use serde_json::{Map, Value};

use crate::nip_oa::{parse_auth_tag, verify_auth_tag};
use crate::SdkError;

/// An identity's current kind:0 as (content, tags) — buildable from a full
/// [`Event`] or from a sig-stripped relay read (Buzz `/query` strips sigs,
/// so requiring a verifiable `Event` here would lock the CLI out).
#[derive(Debug, Clone, Default)]
pub struct CurrentProfile {
    /// Raw content string of the current kind:0.
    pub content: String,
    /// Tags as string vectors, in event order.
    pub tags: Vec<Vec<String>>,
}

impl From<&Event> for CurrentProfile {
    fn from(event: &Event) -> Self {
        Self {
            content: event.content.to_string(),
            tags: event
                .tags
                .iter()
                .map(|tag| tag.as_slice().to_vec())
                .collect(),
        }
    }
}

/// Caller-supplied fields to overlay onto the current profile.
///
/// `None` leaves the field untouched; `Some("")` clears it.
#[derive(Debug, Clone, Default)]
pub struct ProfileOverlay {
    /// Display name. Sets both `name` and `display_name` so every client
    /// precedence order (`display_name || name`) resolves to the same
    /// string; clearing removes both.
    pub name: Option<String>,
    /// Free-text `about` field.
    pub about: Option<String>,
    /// Avatar URL (`picture`). Must be `http(s)://` when non-empty.
    pub avatar_url: Option<String>,
    /// NIP-05 identifier (`nip05`).
    pub nip05: Option<String>,
}

impl ProfileOverlay {
    /// True when no field is set — the merge only normalizes.
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.about.is_none()
            && self.avatar_url.is_none()
            && self.nip05.is_none()
    }
}

/// A merged profile ready to publish, plus what the caller needs to decide
/// *whether* to publish.
#[derive(Debug, Clone)]
pub struct MergedProfile {
    /// Serialized content of the merged profile (key-sorted JSON).
    pub content: String,
    /// Full tag set as string vectors.
    pub tags: Vec<Vec<String>>,
    /// False when the merge equals `current` (same content object, same tag
    /// list) — publish-on-diff callers skip publishing in that case.
    pub changed: bool,
}

impl MergedProfile {
    /// Consume into an [`EventBuilder`] for the caller to sign.
    ///
    /// # Errors
    ///
    /// Returns [`SdkError::InvalidTag`] if a carried tag fails to parse
    /// (cannot happen for tags produced by this module's merges).
    pub fn into_builder(self) -> Result<EventBuilder, SdkError> {
        let tags = self
            .tags
            .iter()
            .map(|tag| {
                Tag::parse(tag.iter().map(String::as_str))
                    .map_err(|e| SdkError::InvalidTag(format!("carried tag failed to parse: {e}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(EventBuilder::new(Kind::Metadata, self.content).tags(tags))
    }
}

/// Returns the first `auth` tag on `current` that verifies for
/// `agent_pubkey`, serialized back to its JSON form.
///
/// Callers use this to route: an identity with a verified tag (or an
/// externally supplied one) is an agent and must go through
/// [`merge_agent_profile`]; anyone else through [`merge_profile`].
pub fn valid_auth_tag(agent_pubkey: &PublicKey, current: &CurrentProfile) -> Option<String> {
    for tag in &current.tags {
        if tag.first().map(String::as_str) != Some("auth") {
            continue;
        }
        let Ok(json) = serde_json::to_string(tag) else {
            continue;
        };
        if verify_auth_tag(&json, agent_pubkey).is_ok() {
            return Some(json);
        }
    }
    None
}

/// Merge `overlay` onto `current`, preserving everything not overlaid.
///
/// - Content starts from `current`'s content object (unparseable or
///   non-object content degrades to empty — the merge self-heals a corrupt
///   profile rather than failing closed on it). Unknown fields are
///   preserved verbatim.
/// - Tags are carried verbatim, in order.
///
/// # Errors
///
/// Returns [`SdkError::InvalidInput`] for a non-`http(s)` avatar URL.
pub fn merge_profile(
    current: Option<&CurrentProfile>,
    overlay: &ProfileOverlay,
) -> Result<MergedProfile, SdkError> {
    if let Some(url) = overlay.avatar_url.as_deref() {
        if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(SdkError::InvalidInput(format!(
                "avatar url must start with http:// or https:// (got {url:?})"
            )));
        }
    }

    let mut content: Map<String, Value> = current
        .and_then(|profile| serde_json::from_str::<Value>(&profile.content).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    apply_field(&mut content, "name", overlay.name.as_deref());
    apply_field(&mut content, "display_name", overlay.name.as_deref());
    apply_field(&mut content, "about", overlay.about.as_deref());
    apply_field(&mut content, "picture", overlay.avatar_url.as_deref());
    apply_field(&mut content, "nip05", overlay.nip05.as_deref());

    let tags = current.map(|profile| profile.tags.clone()).unwrap_or_default();
    finish_merge(current, content, tags)
}

/// [`merge_profile`], plus the agent guarantee: `bot: true` is always set
/// (NIP-24 — an agent profile written through this helper is never
/// mistakable for a person's), and the result carries an `auth` tag that
/// verifies for `agent_pubkey`.
///
/// Tag resolution, in order: a valid tag already on the profile is kept in
/// place (and wins over the fallback); invalid `auth` tags are dropped;
/// with none valid, `auth_tag_fallback` (verified) is appended; with no
/// source at all the merge refuses with [`SdkError::MissingAuthTag`].
pub fn merge_agent_profile(
    agent_pubkey: &PublicKey,
    current: Option<&CurrentProfile>,
    overlay: &ProfileOverlay,
    auth_tag_fallback: Option<&str>,
) -> Result<MergedProfile, SdkError> {
    let generic = merge_profile(current, overlay)?;

    let mut content: Map<String, Value> = match serde_json::from_str(&generic.content) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    content.insert("bot".to_string(), Value::Bool(true));

    let mut tags: Vec<Vec<String>> = Vec::new();
    let mut carried_valid_auth = false;
    for tag in &generic.tags {
        if tag.first().map(String::as_str) != Some("auth") {
            tags.push(tag.clone());
            continue;
        }
        let json = serde_json::to_string(tag)
            .map_err(|e| SdkError::InvalidInput(format!("auth tag serialization: {e}")))?;
        // A tag that fails verification for THIS agent (foreign target,
        // forged sig, malformed) is dropped — carrying it forward would
        // preserve garbage as if it were ownership.
        if !carried_valid_auth && verify_auth_tag(&json, agent_pubkey).is_ok() {
            tags.push(tag.clone());
            carried_valid_auth = true;
        }
    }

    if !carried_valid_auth {
        let Some(fallback) = auth_tag_fallback.filter(|tag| !tag.trim().is_empty()) else {
            return Err(SdkError::MissingAuthTag);
        };
        verify_auth_tag(fallback, agent_pubkey)?;
        let parsed = parse_auth_tag(fallback)?;
        tags.push(parsed.as_slice().to_vec());
    }

    finish_merge(current, content, tags)
}

/// `Some(value)` sets (or, when empty, removes) the field; `None` leaves it.
fn apply_field(content: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    match value {
        None => {}
        Some("") => {
            content.remove(key);
        }
        Some(value) => {
            content.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
}

/// Serialize + compute `changed` against `current`.
fn finish_merge(
    current: Option<&CurrentProfile>,
    content: Map<String, Value>,
    tags: Vec<Vec<String>>,
) -> Result<MergedProfile, SdkError> {
    let changed = match current {
        None => true,
        Some(profile) => {
            let current_content =
                serde_json::from_str::<Value>(&profile.content).unwrap_or(Value::Null);
            current_content != Value::Object(content.clone()) || profile.tags != tags
        }
    };

    let content = serde_json::to_string(&Value::Object(content))
        .map_err(|e| SdkError::InvalidInput(format!("profile content serialization: {e}")))?;

    Ok(MergedProfile {
        content,
        tags,
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nip_oa::compute_auth_tag;
    use nostr::Keys;

    fn agent_and_owner() -> (Keys, Keys) {
        (Keys::generate(), Keys::generate())
    }

    fn auth_tag_for(owner: &Keys, agent: &Keys) -> String {
        compute_auth_tag(owner, &agent.public_key(), "").expect("tag")
    }

    fn profile(content: &str, tags: Vec<Vec<&str>>) -> CurrentProfile {
        CurrentProfile {
            content: content.to_string(),
            tags: tags
                .into_iter()
                .map(|tag| tag.into_iter().map(str::to_string).collect())
                .collect(),
        }
    }

    fn tag_vec(json: &str) -> Vec<String> {
        serde_json::from_str::<Vec<String>>(json).expect("tag json")
    }

    fn overlay(name: Option<&str>, about: Option<&str>, avatar: Option<&str>) -> ProfileOverlay {
        ProfileOverlay {
            name: name.map(str::to_string),
            about: about.map(str::to_string),
            avatar_url: avatar.map(str::to_string),
            nip05: None,
        }
    }

    fn content_value(merged: &MergedProfile) -> Value {
        serde_json::from_str(&merged.content).expect("valid json")
    }

    #[test]
    fn generic_merge_preserves_unknown_fields_and_all_tags() {
        let current = profile(
            r#"{"name":"Kevin","lud16":"k@example.org","custom":{"deep":1}}"#,
            vec![vec!["client", "sprig"], vec!["auth", "junk", "", "junk"]],
        );

        let merged = merge_profile(
            Some(&current),
            &overlay(None, Some("hello"), Some("https://x.example/a.png")),
        )
        .expect("merge");

        let value = content_value(&merged);
        assert_eq!(value["lud16"], "k@example.org");
        assert_eq!(value["custom"]["deep"], 1);
        assert_eq!(value["about"], "hello");
        assert_eq!(value["picture"], "https://x.example/a.png");
        assert!(value.get("bot").is_none(), "generic merge never brands");
        assert_eq!(merged.tags, current.tags, "tags carried verbatim");
    }

    #[test]
    fn generic_merge_is_idempotent_and_diff_aware() {
        let current = profile(r#"{"name":"Kevin"}"#, vec![]);
        let unchanged = merge_profile(Some(&current), &ProfileOverlay::default()).expect("merge");
        assert!(!unchanged.changed, "no overlay, no change");

        let changed =
            merge_profile(Some(&current), &overlay(Some("Kev"), None, None)).expect("merge");
        assert!(changed.changed);
    }

    #[test]
    fn agent_merge_preserves_unknown_content_fields_and_foreign_tags() {
        let (agent, owner) = agent_and_owner();
        let auth = auth_tag_for(&owner, &agent);
        let current = profile(
            r#"{"name":"Hermes","lud16":"h@example.org"}"#,
            vec![vec!["client", "sprig"]],
        );

        let merged = merge_agent_profile(
            &agent.public_key(),
            Some(&current),
            &overlay(None, None, Some("https://x.example/a.png")),
            Some(&auth),
        )
        .expect("merge");

        let value = content_value(&merged);
        assert_eq!(value["lud16"], "h@example.org");
        assert_eq!(value["name"], "Hermes");
        assert_eq!(value["picture"], "https://x.example/a.png");
        assert_eq!(value["bot"], true);
        assert!(merged.tags.iter().any(|t| t.first().map(String::as_str) == Some("client")));
        assert!(merged.tags.iter().any(|t| t.first().map(String::as_str) == Some("auth")));
    }

    #[test]
    fn agent_merge_carries_profile_tag_and_prefers_it_over_fallback() {
        let (agent, owner) = agent_and_owner();
        let profile_tag = auth_tag_for(&owner, &agent);
        let current = profile(r#"{"name":"a"}"#, vec![]);
        let mut current = current;
        current.tags.push(tag_vec(&profile_tag));

        let other_owner = Keys::generate();
        let fallback = auth_tag_for(&other_owner, &agent);

        let merged = merge_agent_profile(
            &agent.public_key(),
            Some(&current),
            &ProfileOverlay::default(),
            Some(&fallback),
        )
        .expect("merge");

        let auth_tags: Vec<_> = merged
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("auth"))
            .collect();
        assert_eq!(auth_tags.len(), 1);
        assert_eq!(auth_tags[0][1], owner.public_key().to_hex());
    }

    #[test]
    fn agent_merge_falls_back_when_profile_tag_is_foreign() {
        let (agent, owner) = agent_and_owner();
        let stranger = Keys::generate();
        let foreign = auth_tag_for(&owner, &stranger);
        let mut current = profile(r#"{"name":"a"}"#, vec![]);
        current.tags.push(tag_vec(&foreign));

        let fallback = auth_tag_for(&owner, &agent);
        let merged = merge_agent_profile(
            &agent.public_key(),
            Some(&current),
            &ProfileOverlay::default(),
            Some(&fallback),
        )
        .expect("merge");

        let auth_tags: Vec<_> = merged
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("auth"))
            .collect();
        assert_eq!(auth_tags.len(), 1, "foreign tag dropped, fallback appended");
        assert!(
            verify_auth_tag(
                &serde_json::to_string(&auth_tags[0]).expect("json"),
                &agent.public_key()
            )
            .is_ok()
        );
    }

    #[test]
    fn agent_merge_refuses_without_any_auth_tag() {
        let (agent, _) = agent_and_owner();
        let current = profile(r#"{"name":"a"}"#, vec![]);

        let err = merge_agent_profile(
            &agent.public_key(),
            Some(&current),
            &ProfileOverlay::default(),
            None,
        )
        .expect_err("must refuse");
        assert!(matches!(err, SdkError::MissingAuthTag));

        let err = merge_agent_profile(&agent.public_key(), None, &ProfileOverlay::default(), None)
            .expect_err("must refuse with no profile at all");
        assert!(matches!(err, SdkError::MissingAuthTag));
    }

    #[test]
    fn agent_merge_sets_bot_and_both_name_fields_and_clears_on_empty() {
        let (agent, owner) = agent_and_owner();
        let fallback = auth_tag_for(&owner, &agent);

        let merged = merge_agent_profile(
            &agent.public_key(),
            None,
            &overlay(Some("Hermes"), Some("chatty"), None),
            Some(&fallback),
        )
        .expect("merge");
        let value = content_value(&merged);
        assert_eq!(value["bot"], true);
        assert_eq!(value["name"], "Hermes");
        assert_eq!(value["display_name"], "Hermes");
        assert_eq!(value["about"], "chatty");

        let published = CurrentProfile {
            content: merged.content.clone(),
            tags: merged.tags.clone(),
        };
        let cleared = merge_agent_profile(
            &agent.public_key(),
            Some(&published),
            &overlay(None, Some(""), None),
            None,
        )
        .expect("merge");
        let value = content_value(&cleared);
        assert!(value.get("about").is_none());
        assert_eq!(value["name"], "Hermes");
    }

    #[test]
    fn rejects_non_http_avatar() {
        let err = merge_profile(None, &overlay(None, None, Some("ftp://x/a.png")))
            .expect_err("must reject");
        assert!(matches!(err, SdkError::InvalidInput(_)));
    }

    #[test]
    fn agent_merge_is_idempotent_publish_then_remerge_reports_unchanged() {
        let (agent, owner) = agent_and_owner();
        let fallback = auth_tag_for(&owner, &agent);
        let overlay = overlay(Some("Hermes"), None, Some("https://x.example/a.png"));

        let first = merge_agent_profile(&agent.public_key(), None, &overlay, Some(&fallback))
            .expect("merge");
        assert!(first.changed);

        let published = CurrentProfile {
            content: first.content.clone(),
            tags: first.tags.clone(),
        };
        let second = merge_agent_profile(
            &agent.public_key(),
            Some(&published),
            &overlay,
            Some(&fallback),
        )
        .expect("merge");
        assert!(!second.changed, "same overlay over its own output is a no-op");

        let third = merge_agent_profile(
            &agent.public_key(),
            Some(&published),
            &ProfileOverlay::default(),
            None,
        )
        .expect("merge");
        assert!(
            !third.changed,
            "empty overlay over a normalized profile is a no-op"
        );
    }

    #[test]
    fn valid_auth_tag_finds_only_verifying_tags() {
        let (agent, owner) = agent_and_owner();
        let good = auth_tag_for(&owner, &agent);
        let stranger = Keys::generate();
        let foreign = auth_tag_for(&owner, &stranger);

        let mut with_good = profile(r#"{}"#, vec![]);
        with_good.tags.push(tag_vec(&foreign));
        with_good.tags.push(tag_vec(&good));
        assert!(valid_auth_tag(&agent.public_key(), &with_good).is_some());

        let mut only_foreign = profile(r#"{}"#, vec![]);
        only_foreign.tags.push(tag_vec(&foreign));
        assert!(valid_auth_tag(&agent.public_key(), &only_foreign).is_none());
    }

    #[test]
    fn self_healing_on_corrupt_content() {
        let (agent, owner) = agent_and_owner();
        let auth = auth_tag_for(&owner, &agent);
        let current = profile("not json at all", vec![]);

        let merged = merge_agent_profile(
            &agent.public_key(),
            Some(&current),
            &overlay(Some("Hermes"), None, None),
            Some(&auth),
        )
        .expect("merge");
        let value = content_value(&merged);
        assert_eq!(value["name"], "Hermes");
        assert_eq!(value["bot"], true);
    }

    #[test]
    fn into_builder_round_trips_through_a_signed_event() {
        let (agent, owner) = agent_and_owner();
        let auth = auth_tag_for(&owner, &agent);
        let merged = merge_agent_profile(
            &agent.public_key(),
            None,
            &overlay(Some("Hermes"), None, None),
            Some(&auth),
        )
        .expect("merge");

        let event = merged
            .clone()
            .into_builder()
            .expect("builder")
            .sign_with_keys(&agent)
            .expect("sign");
        let round_tripped = CurrentProfile::from(&event);
        let again = merge_agent_profile(
            &agent.public_key(),
            Some(&round_tripped),
            &ProfileOverlay::default(),
            None,
        )
        .expect("merge");
        assert!(!again.changed);
    }
}
