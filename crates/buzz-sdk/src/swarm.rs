//! Swarm definition events (kind:30178) — typed content, builder, and parse.
//!
//! A swarm is an owner-authored delegation group: a required leader agent,
//! member agents with per-member task descriptions, leader instructions, and
//! a reporting policy. Addressed by `(owner_pubkey, 30178, d = swarm id)`.
//!
//! Content follows the never-wipe `Option` discipline used by team events:
//! an absent field means "leave the stored value untouched", so an older
//! writer can never blank a field it does not know about. Unknown fields are
//! preserved on round-trip via `serde_json::Value` capture.
//!
//! Initiation protocol (see docs/swarms.md): clients address a swarm by
//! mentioning the LEADER's pubkey together with a [`SWARM_TAG`] naming the
//! swarm id. The leader's harness enters delegation mode only for mentions
//! carrying that tag; members need no swarm awareness at all.

use nostr::{EventBuilder, Kind, Tag};
use serde::{Deserialize, Serialize};

use buzz_core::kind::KIND_SWARM;

/// Tag name carried on messages that address a swarm: `["swarm", <swarm-id>]`.
pub const SWARM_TAG: &str = "swarm";

/// One swarm member: an agent pubkey plus the owner-authored description of
/// what this agent should be assigned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwarmMember {
    /// Member agent pubkey (64-char hex).
    pub pubkey: String,
    /// What this agent should be assigned ("do bug fixes", "generate
    /// images", …). Shown to the leader in its roster block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The JSON body stored in a swarm event's content field.
///
/// All fields are `Option` (never-wipe): writers serialize only what they
/// know, readers treat absence as "unchanged". `extra` preserves unknown
/// fields written by newer clients.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SwarmContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Leader agent pubkey (64-char hex). Required for a functioning swarm;
    /// `Option` only for the never-wipe discipline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leader_pubkey: Option<String>,
    /// Leader/manager instructions — injected as the high-priority block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<SwarmMember>>,
    /// When true the leader instructs members to report back on completion
    /// and evaluates their report against `evaluation_criteria`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_back: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluation_criteria: Option<String>,
    /// Unknown fields from newer writers, preserved verbatim.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn check_hex_pubkey(value: &str, field: &str) -> Result<(), String> {
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{field} must be 64-char hex, got: {value}"))
    }
}

/// Build a kind:30178 swarm definition event.
///
/// `d_tag` is the swarm's stable id (any non-empty string; clients use a
/// uuid). Validates every pubkey present; a leaderless content body is
/// permitted at this layer (partial update semantics) — UIs enforce the
/// required leader at write time.
pub fn build_swarm_definition(d_tag: &str, content: &SwarmContent) -> Result<EventBuilder, String> {
    if d_tag.trim().is_empty() {
        return Err("swarm d_tag must not be empty".into());
    }
    if let Some(leader) = &content.leader_pubkey {
        check_hex_pubkey(leader, "leader_pubkey")?;
    }
    for member in content.members.iter().flatten() {
        check_hex_pubkey(&member.pubkey, "member pubkey")?;
    }

    let body = serde_json::to_string(content)
        .map_err(|e| format!("failed to serialize swarm content: {e}"))?;
    let d = Tag::parse(["d", d_tag]).map_err(|e| format!("bad d tag: {e}"))?;
    Ok(EventBuilder::new(Kind::Custom(KIND_SWARM as u16), body).tags([d]))
}

/// Parse a kind:30178 event's content — the inbound counterpart of
/// [`build_swarm_definition`]. Unknown fields land in `extra`.
pub fn parse_swarm_content(content: &str) -> Result<SwarmContent, String> {
    serde_json::from_str(content).map_err(|e| format!("invalid swarm content: {e}"))
}

/// Extract the swarm id from a message's `["swarm", <id>]` tag, if present.
///
/// Used by the leader's harness to decide whether a mention addresses a
/// swarm (delegation mode) or the agent personally (plain mode).
pub fn swarm_tag_value(tags: &[Vec<String>]) -> Option<&str> {
    tags.iter()
        .find(|tag| tag.len() >= 2 && tag[0] == SWARM_TAG)
        .map(|tag| tag[1].as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leader() -> String {
        "a".repeat(64)
    }

    fn full_content() -> SwarmContent {
        SwarmContent {
            name: Some("Build crew".into()),
            leader_pubkey: Some(leader()),
            instructions: Some("Prioritize small diffs.".into()),
            members: Some(vec![SwarmMember {
                pubkey: "b".repeat(64),
                description: Some("do bug fixes".into()),
            }]),
            report_back: Some(true),
            evaluation_criteria: Some("Tests pass.".into()),
            extra: Default::default(),
        }
    }

    #[test]
    fn round_trips_full_content() {
        let content = full_content();
        let body = serde_json::to_string(&content).unwrap();
        let parsed = parse_swarm_content(&body).unwrap();
        assert_eq!(parsed, content);
    }

    #[test]
    fn absent_fields_stay_absent_never_wiped() {
        // A partial writer must not serialize fields it does not carry.
        let partial = SwarmContent {
            name: Some("Renamed".into()),
            ..Default::default()
        };
        let body = serde_json::to_string(&partial).unwrap();
        assert!(!body.contains("leader_pubkey"));
        assert!(!body.contains("members"));
        assert!(!body.contains("report_back"));

        let parsed = parse_swarm_content(&body).unwrap();
        assert_eq!(parsed.leader_pubkey, None);
        assert_eq!(parsed.members, None);
    }

    #[test]
    fn unknown_fields_survive_round_trip() {
        let body = r#"{"name":"x","future_field":{"nested":1}}"#;
        let parsed = parse_swarm_content(body).unwrap();
        assert!(parsed.extra.contains_key("future_field"));
        let re = serde_json::to_string(&parsed).unwrap();
        assert!(re.contains("future_field"));
    }

    #[test]
    fn builder_validates_pubkeys_and_d_tag() {
        let mut content = full_content();
        assert!(build_swarm_definition("swarm-1", &content).is_ok());
        assert!(build_swarm_definition("  ", &content).is_err());
        content.leader_pubkey = Some("nothex".into());
        assert!(build_swarm_definition("swarm-1", &content).is_err());
        let mut content = full_content();
        content.members.as_mut().unwrap()[0].pubkey = "short".into();
        assert!(build_swarm_definition("swarm-1", &content).is_err());
    }

    #[test]
    fn swarm_tag_value_finds_first_swarm_tag() {
        let tags = vec![
            vec!["p".to_string(), "a".repeat(64)],
            vec![SWARM_TAG.to_string(), "swarm-42".to_string()],
        ];
        assert_eq!(swarm_tag_value(&tags), Some("swarm-42"));
        assert_eq!(swarm_tag_value(&[vec!["p".to_string()]]), None);
    }
}
