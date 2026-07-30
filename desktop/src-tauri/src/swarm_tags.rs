//! Swarm-aliasing reference tags (docs/swarms.md §2.1).
//!
//! Extracted from `events.rs` for the file-size guard; the validation
//! contract mirrors `events::mention_reference_tags` — every extra-tag
//! channel from the frontend is prefix-validated so it cannot be used to
//! smuggle forged `"h"`, `"e"`, or `"p"` tags into a signed event.

use nostr::Tag;

fn tag(parts: Vec<&str>) -> Result<Tag, String> {
    Tag::parse(parts).map_err(|e| format!("invalid tag: {e}"))
}

/// Validate swarm-aliasing reference tags into `["swarm", <swarm-id>]` tags.
/// Any tag whose first element is not `"swarm"` is rejected.
pub fn swarm_reference_tags(swarm_tags: &[Vec<String>]) -> Result<Vec<Tag>, String> {
    let mut tags = Vec::with_capacity(swarm_tags.len());
    for swarm_tag in swarm_tags {
        if swarm_tag.first().map(String::as_str) != Some("swarm") {
            return Err(format!(
                "swarm tags must use 'swarm' prefix (got {:?})",
                swarm_tag.first()
            ));
        }
        let Some(swarm_id) = swarm_tag.get(1) else {
            return Err("swarm tag missing swarm id".into());
        };
        if swarm_id.trim().is_empty() {
            return Err("swarm tag id must not be empty".into());
        }
        tags.push(tag(vec!["swarm", swarm_id])?);
    }
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_swarm_tags_and_rejects_foreign_prefixes() {
        let ok = swarm_reference_tags(&[vec!["swarm".into(), "s-1".into()]]).unwrap();
        assert_eq!(ok.len(), 1);

        assert!(swarm_reference_tags(&[vec!["p".into(), "x".into()]]).is_err());
        assert!(swarm_reference_tags(&[vec!["swarm".into()]]).is_err());
        assert!(swarm_reference_tags(&[vec!["swarm".into(), "  ".into()]]).is_err());
        assert!(swarm_reference_tags(&[]).unwrap().is_empty());
    }
}
