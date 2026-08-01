//! Fetch the community guide (kind:30979) and render it into a prompt
//! section, refreshed when a new session is born.
//!
//! The guide is community-level orientation authored by the owner/admins —
//! conventions, "how we work here", pointers. It is relay-served rather than
//! baked into seeded workspace files precisely so an edit propagates to every
//! agent on every host at its next session, with no binary rollout and no
//! per-host drift (see `docs/agent-orientation.md`).
//!
//! Cache semantics (mirroring the core-memory fetch contract):
//! - A definitive answer — guide found, or confirmed absence — overwrites the
//!   cache. Absence must win so a deleted/cleared guide stops steering the
//!   agent on the next session.
//! - A fetch *error* keeps the cached value: a relay outage must not strip
//!   orientation that was already delivered.
//! - Callers bound the refresh with a timeout; a timed-out refresh simply
//!   leaves the cache as-is. Session creation is never blocked.

use nostr::Event;
use std::sync::RwLock;

use buzz_core::kind::KIND_COMMUNITY_GUIDE;

use crate::relay::RestClient;

/// Section header rendered into the prompt.
const SECTION_LABEL: &str = "Community Guide";

/// Fixed `d` tag of the community guide head (one addressable slot per
/// author; the newest verified head across authors wins).
pub const COMMUNITY_GUIDE_D_TAG: &str = "guide";

/// Result-set bound for the head query. The relay stores at most one head
/// per author (NIP-33); several owner/admin authors may each hold one.
const GUIDE_QUERY_LIMIT: usize = 8;

/// Agent-global cache for the rendered community-guide section.
///
/// Lives in `PromptContext`, which is `Arc`-shared across prompt tasks, so
/// the value sits behind a lock. Refreshes fire only when a new session is
/// born; concurrent racers both carry the same relay head, so last write
/// wins harmlessly. The lock is never held across an await.
#[derive(Debug, Default)]
pub struct CommunityGuideCache {
    value: RwLock<Option<String>>,
}

impl CommunityGuideCache {
    /// Current cached section (pre-headered `[Community Guide]\n…`), if any.
    pub fn get(&self) -> Option<String> {
        self.value
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Refresh the cache from the relay.
    pub async fn refresh(&self, rest: &RestClient) {
        match fetch_guide_section(rest).await {
            Ok(next) => {
                let mut value = self
                    .value
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if *value != next {
                    tracing::info!(
                        target: "community::guide",
                        section_len = next.as_deref().map(str::len).unwrap_or(0),
                        was_set = value.is_some(),
                        "community guide updated"
                    );
                }
                *value = next;
            }
            Err(reason) => {
                tracing::warn!(
                    target: "community::guide",
                    "community guide fetch failed: {reason} — keeping cached value"
                );
            }
        }
    }
}

/// Query the relay for the guide head and render the prompt section.
///
/// Returns:
/// - `Ok(Some(section))` when a verified head with non-blank content exists,
/// - `Ok(None)` when the relay confirmed absence (empty result set, or only
///   blank-content heads — a cleared guide steers nothing),
/// - `Err(reason)` for transport failures or a non-empty result set with no
///   verifiable candidate — those must not be mistaken for absence.
async fn fetch_guide_section(rest: &RestClient) -> Result<Option<String>, String> {
    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(KIND_COMMUNITY_GUIDE as u16))
        .custom_tags(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::D),
            [COMMUNITY_GUIDE_D_TAG],
        )
        .limit(GUIDE_QUERY_LIMIT);

    let value = rest
        .query(&[filter])
        .await
        .map_err(|e| format!("relay query failed: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "relay query returned non-array".to_string())?;
    decode_guide_section(arr)
}

/// Pure decoder: pick the newest signature-verified head and render it.
///
/// The relay write-gates the kind to owner/admin authors, so authorship is
/// not re-derived here — but signatures are still verified so a corrupted or
/// forged row can never steer the prompt. Ties on `created_at` break on the
/// event id for determinism.
fn decode_guide_section(arr: &[serde_json::Value]) -> Result<Option<String>, String> {
    if arr.is_empty() {
        return Ok(None);
    }
    let mut newest: Option<Event> = None;
    for ev_json in arr {
        let event: Event = match serde_json::from_value(ev_json.clone()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if event.verify().is_err() {
            continue;
        }
        let wins = match &newest {
            None => true,
            Some(current) => {
                (event.created_at, event.id.to_hex()) > (current.created_at, current.id.to_hex())
            }
        };
        if wins {
            newest = Some(event);
        }
    }
    let Some(head) = newest else {
        return Err("relay returned guide candidates but none verified".to_string());
    };
    let content = head.content.trim();
    if content.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!("[{SECTION_LABEL}]\n{content}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn signed_guide(keys: &Keys, content: &str, created_at: u64) -> serde_json::Value {
        let event = EventBuilder::new(Kind::Custom(KIND_COMMUNITY_GUIDE as u16), content)
            .tag(Tag::parse(["d", COMMUNITY_GUIDE_D_TAG]).unwrap())
            .custom_created_at(nostr::Timestamp::from(created_at))
            .sign_with_keys(keys)
            .unwrap();
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn empty_result_is_confirmed_absence() {
        assert_eq!(decode_guide_section(&[]), Ok(None));
    }

    #[test]
    fn newest_verified_head_wins() {
        let keys = Keys::generate();
        let old = signed_guide(&keys, "old conventions", 100);
        let new = signed_guide(&keys, "new conventions", 200);
        let section = decode_guide_section(&[old, new]).unwrap().unwrap();
        assert_eq!(section, "[Community Guide]\nnew conventions");
    }

    #[test]
    fn unverifiable_candidates_are_an_error_not_absence() {
        let keys = Keys::generate();
        let mut forged = signed_guide(&keys, "forged", 100);
        forged["content"] = serde_json::Value::String("tampered".into());
        let err = decode_guide_section(&[forged]).unwrap_err();
        assert!(err.contains("none verified"), "got: {err}");
    }

    #[test]
    fn tampered_head_never_shadows_a_verified_one() {
        let keys = Keys::generate();
        let good = signed_guide(&keys, "real guide", 100);
        let mut forged = signed_guide(&keys, "forged", 999);
        forged["content"] = serde_json::Value::String("tampered".into());
        let section = decode_guide_section(&[forged, good]).unwrap().unwrap();
        assert_eq!(section, "[Community Guide]\nreal guide");
    }

    #[test]
    fn blank_content_is_absence() {
        // Publishing an empty guide is the supported way to clear it; a
        // whitespace-only body must not inject an empty section header.
        let keys = Keys::generate();
        let blank = signed_guide(&keys, "  \n ", 100);
        assert_eq!(decode_guide_section(&[blank]), Ok(None));
    }
}
