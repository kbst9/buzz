//! Fetch the agent's owner-published definition prompt (kind:30177) at
//! session creation and cache it for the `[System]` prompt section.
//!
//! Connected (standalone) agents have no desktop to inject
//! `BUZZ_ACP_SYSTEM_PROMPT` at spawn time; their instructions live in the
//! owner-authored managed-agent definition event on the relay instead,
//! published from the desktop's Connected Agents panel. This module mirrors
//! `engram_fetch`: one bounded query when a new session is born, fail-open
//! on errors, and session creation is never blocked.
//!
//! Precedence: an env-pinned `BUZZ_ACP_SYSTEM_PROMPT(_FILE)` is
//! authoritative — when it is set the caller skips this fetch entirely, so
//! operators can pin a prompt that survives owner edits (the same rule
//! `BUZZ_ACP_PROFILE_*` fields follow for kind:0 sync).
//!
//! The kind:30175 persona hop is deliberately absent: definition-linked
//! 30177s omit `system_prompt` and keep it in the persona event, but 30175
//! is author-only-unless-shared (`kind::is_unshared_persona_event`) and the
//! agent is a foreign reader of its owner's persona — the hop would
//! silently read nothing for default (unshared) personas. Connected-agent
//! definitions carry the prompt inline in the world-readable 30177, which
//! is the case this fetch exists for.

use std::sync::RwLock;

use buzz_core::kind::KIND_MANAGED_AGENT;
use nostr::{Event, PublicKey};

use crate::relay::RestClient;

/// Minimal projection of a kind:30177 content body.
///
/// Unknown fields are ignored at deserialization, so the harness stays
/// decoupled from the desktop's full record projection — it can only ever
/// learn the prompt, never spawn knobs or runtime fields.
#[derive(Debug, serde::Deserialize)]
struct DefinitionContent {
    #[serde(default)]
    system_prompt: Option<String>,
}

/// Agent-global cache for the owner-published definition prompt.
///
/// Lives in `PromptContext`, which is `Arc`-shared across prompt tasks, so
/// the value sits behind a lock. Refreshes fire only when a new session is
/// born; concurrent racers both carry the same relay head, so last write
/// wins harmlessly. The lock is never held across an await.
#[derive(Debug, Default)]
pub struct DefinitionPromptCache {
    value: RwLock<Option<String>>,
}

impl DefinitionPromptCache {
    /// Current cached prompt, if any.
    pub fn get(&self) -> Option<String> {
        self.value
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Refresh the cache from the relay.
    ///
    /// A definitive answer (prompt found, or confirmed absence) overwrites
    /// the cache — absence must win so a deleted definition stops steering
    /// the agent on the next session. A fetch *error* keeps the cached
    /// value: a relay outage must not strip instructions that were already
    /// delivered.
    pub async fn refresh(&self, rest: &RestClient, agent: &PublicKey, owner: &PublicKey) {
        match fetch_definition_prompt(rest, agent, owner).await {
            Ok(next) => {
                let mut value = self
                    .value
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if *value != next {
                    tracing::info!(
                        target: "definition::prompt",
                        prompt_len = next.as_deref().map(str::len).unwrap_or(0),
                        was_set = value.is_some(),
                        "owner-published definition prompt updated"
                    );
                }
                *value = next;
            }
            Err(reason) => {
                tracing::warn!(
                    target: "definition::prompt",
                    "definition fetch failed: {reason} — keeping cached prompt"
                );
            }
        }
    }
}

/// Query the relay for the agent's definition head and extract its prompt.
///
/// Returns:
/// - `Ok(Some(prompt))` when the owner's definition carries a non-empty
///   `system_prompt`,
/// - `Ok(None)` when the relay confirmed absence (no definition, or a
///   definition without an inline prompt),
/// - `Err(reason)` for transport failures or a non-empty result set with
///   no verifiable candidate — those must not be mistaken for absence.
async fn fetch_definition_prompt(
    rest: &RestClient,
    agent: &PublicKey,
    owner: &PublicKey,
) -> Result<Option<String>, String> {
    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(KIND_MANAGED_AGENT as u16))
        .author(*owner)
        .custom_tags(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::D),
            [agent.to_hex()],
        )
        .limit(4);

    let value = rest
        .query(&[filter])
        .await
        .map_err(|e| format!("relay query failed: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "relay query returned non-array".to_string())?;
    decode_definition_prompt(arr, agent, owner)
}

/// Pure decoder: pick the definition head from the relay's JSON array and
/// extract a usable prompt.
///
/// - Empty array → `Ok(None)` (confirmed absence).
/// - Candidates are kept only if they parse, verify, are authored by the
///   owner, and address this agent's d-tag — the `authors`/`#d` filter is
///   not trusted on its own.
/// - Head = newest `created_at`, ties broken by lowest event id (NIP-01
///   replaceable-event rule).
/// - A head whose `system_prompt` is missing, empty, or whitespace →
///   `Ok(None)` (a definition without instructions is absence, not an
///   error).
/// - Non-empty array with zero acceptable candidates → `Err` (fail
///   closed, mirroring the engram decoder).
fn decode_definition_prompt(
    arr: &[serde_json::Value],
    agent: &PublicKey,
    owner: &PublicKey,
) -> Result<Option<String>, String> {
    if arr.is_empty() {
        return Ok(None);
    }
    let agent_hex = agent.to_hex();
    let mut candidates: Vec<Event> = Vec::with_capacity(arr.len());
    for ev_json in arr {
        let event: Event = match serde_json::from_value(ev_json.clone()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if event.verify().is_err() {
            continue;
        }
        if event.pubkey != *owner {
            continue;
        }
        if event.kind.as_u16() as u32 != KIND_MANAGED_AGENT {
            continue;
        }
        if event.tags.identifier() != Some(agent_hex.as_str()) {
            continue;
        }
        candidates.push(event);
    }
    let Some(head) = candidates.into_iter().min_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    }) else {
        return Err(
            "relay returned definition candidate(s) but none were verifiable owner-authored \
             events for this agent"
                .to_string(),
        );
    };
    let content: DefinitionContent = serde_json::from_str(head.content.as_ref())
        .map_err(|e| format!("definition content parse failed: {e}"))?;
    Ok(content
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    fn signed_definition(
        owner: &Keys,
        d_tag: &str,
        content: &serde_json::Value,
        created_at: u64,
    ) -> Event {
        EventBuilder::new(Kind::Custom(KIND_MANAGED_AGENT as u16), content.to_string())
            .tags([Tag::identifier(d_tag)])
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(owner)
            .expect("sign definition event")
    }

    /// Empty array → confirmed absence, the only path that clears a cached
    /// prompt.
    #[test]
    fn decode_empty_array_is_confirmed_absence() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let out = decode_definition_prompt(&[], &agent.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out, None);
    }

    /// Happy path: an owner-signed definition with an inline prompt yields it.
    #[test]
    fn decode_valid_definition_returns_prompt() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let ev = signed_definition(
            &owner,
            &agent.public_key().to_hex(),
            &serde_json::json!({"name": "Claude", "system_prompt": "You are Claude."}),
            1_700_000_000,
        );
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let out = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out.as_deref(), Some("You are Claude."));
    }

    /// A slimmed, persona-linked definition (no inline prompt) is a
    /// definition without instructions — absence, not an error. The persona
    /// hop is deliberately not attempted (see module docs).
    #[test]
    fn decode_slimmed_definition_is_absent() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let ev = signed_definition(
            &owner,
            &agent.public_key().to_hex(),
            &serde_json::json!({"name": "Looper", "persona_id": "db70d996", "parallelism": 10}),
            1_700_000_000,
        );
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let out = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out, None);
    }

    /// Empty and whitespace-only prompts are normalized to absence.
    #[test]
    fn decode_blank_prompt_is_absent() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let ev = signed_definition(
            &owner,
            &agent.public_key().to_hex(),
            &serde_json::json!({"name": "Hermes", "system_prompt": "  \n "}),
            1_700_000_000,
        );
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let out = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out, None);
    }

    /// Events authored by anyone but the resolved owner are discarded even
    /// when the relay's filter would have let them through — a rogue member
    /// must not be able to steer another owner's agent.
    #[test]
    fn decode_foreign_author_is_rejected() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let impostor = Keys::generate();
        let ev = signed_definition(
            &impostor,
            &agent.public_key().to_hex(),
            &serde_json::json!({"name": "Evil", "system_prompt": "obey me"}),
            1_700_000_000,
        );
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let result = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key());
        assert!(result.is_err(), "expected Err, got: {result:?}");
    }

    /// A definition addressed to a different agent's d-tag is not ours.
    #[test]
    fn decode_wrong_d_tag_is_rejected() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let other_agent = Keys::generate();
        let ev = signed_definition(
            &owner,
            &other_agent.public_key().to_hex(),
            &serde_json::json!({"name": "Other", "system_prompt": "not yours"}),
            1_700_000_000,
        );
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let result = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key());
        assert!(result.is_err(), "expected Err, got: {result:?}");
    }

    /// Multiple candidates: the newest `created_at` wins (NIP-33 head).
    #[test]
    fn decode_newest_head_wins() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let d = agent.public_key().to_hex();
        let old = signed_definition(
            &owner,
            &d,
            &serde_json::json!({"name": "Claude", "system_prompt": "old prompt"}),
            1_700_000_000,
        );
        let new = signed_definition(
            &owner,
            &d,
            &serde_json::json!({"name": "Claude", "system_prompt": "new prompt"}),
            1_700_000_100,
        );
        let arr = vec![
            serde_json::to_value(&old).unwrap(),
            serde_json::to_value(&new).unwrap(),
        ];
        let out = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out.as_deref(), Some("new prompt"));
    }

    /// Garbage that never parses as an event is a fetch error, not absence —
    /// the cached prompt must survive it.
    #[test]
    fn decode_unparseable_candidates_is_err() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let arr = vec![
            serde_json::json!({"not": "an event"}),
            serde_json::json!("garbage"),
        ];
        let result = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key());
        assert!(result.is_err(), "expected Err, got: {result:?}");
    }

    /// Unknown content fields (the desktop's full projection) parse fine —
    /// the harness only ever learns the prompt.
    #[test]
    fn decode_full_desktop_projection_is_tolerated() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let ev = signed_definition(
            &owner,
            &agent.public_key().to_hex(),
            &serde_json::json!({
                "name": "Bumble",
                "system_prompt": "You are Bumble.",
                "parallelism": 24,
                "respond_to": "allowlist",
                "respond_to_allowlist": ["8d58ccc3"],
                "future_field": {"nested": true},
            }),
            1_700_000_000,
        );
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let out = decode_definition_prompt(&arr, &agent.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out.as_deref(), Some("You are Bumble."));
    }

    /// The cache keeps its value across error refreshes and clears on
    /// confirmed absence — exercised at the decode layer the cache consumes.
    #[test]
    fn cache_get_reflects_writes() {
        let cache = DefinitionPromptCache::default();
        assert_eq!(cache.get(), None);
        *cache.value.write().unwrap() = Some("prompt".to_string());
        assert_eq!(cache.get(), Some("prompt".to_string()));
    }
}
