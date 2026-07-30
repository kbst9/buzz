//! Swarm self-deployment — members join the channel when the swarm does
//! (docs/swarms.md §2.1 "quick deployment").
//!
//! A swarm needs no channel add of its own (it is mention aliasing), but a
//! member that is not a channel member has no subscription there: an
//! assignment mentioning it would never be delivered and the member would
//! silently ghost. So when the leader enters a swarm-addressed turn, its
//! harness mechanically publishes kind:9000 member-adds for every swarm
//! member missing from the channel — BEFORE the model runs, so the later
//! assignment mention lands after their membership (the member's
//! replay-from-membership subscribe then delivers it even if it races).
//!
//! The relay's `channel_add_policy` remains the authorizer, exactly as for
//! the huddle add path. Rejected adds are reported back so the roster can
//! mark those members unreachable instead of letting the leader assign
//! into the void. Fail-open discipline: if the membership snapshot cannot
//! be fetched, NO adds are published (re-adding existing members would
//! spam visible system rows) and nobody is marked unreachable.

use std::collections::HashSet;

use nostr::Keys;
use uuid::Uuid;

use crate::relay::RestClient;
use crate::swarm_fetch::LeaderSwarm;

/// Ceiling on adds per swarm-addressed turn (matches the dialog's practical
/// swarm sizes; anything beyond is a misconfigured definition).
const MAX_ADDS_PER_TURN: usize = 8;

/// Decode the current member pubkeys (lowercase hex) from a kind:39002
/// query result: newest verifiable event wins, its `p` tags are the roster.
pub fn members_from_39002(arr: &[serde_json::Value]) -> Option<HashSet<String>> {
    let mut newest: Option<nostr::Event> = None;
    for ev_json in arr {
        let Ok(event) = serde_json::from_value::<nostr::Event>(ev_json.clone()) else {
            continue;
        };
        if event.verify().is_err() {
            continue;
        }
        let newer = newest
            .as_ref()
            .is_none_or(|current| event.created_at > current.created_at);
        if newer {
            newest = Some(event);
        }
    }
    let head = newest?;
    Some(
        head.tags
            .iter()
            .filter_map(|tag| {
                let parts = tag.as_slice();
                (parts.len() >= 2 && parts[0] == "p").then(|| parts[1].to_lowercase())
            })
            .collect(),
    )
}

/// Swarm members absent from the channel roster (lowercase hex, deduped,
/// definition order preserved).
pub fn missing_members(swarm: &LeaderSwarm, present: &HashSet<String>) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for member in swarm.content.members.iter().flatten() {
        let pubkey = member.pubkey.to_lowercase();
        if !present.contains(&pubkey) && !missing.contains(&pubkey) {
            missing.push(pubkey);
        }
    }
    missing
}

/// Ensure every swarm member can hear this channel; returns the members
/// that could NOT be made reachable (relay declined the add, or the add
/// failed) so the roster can mark them.
///
/// Never errors: every failure path degrades to "publish nothing extra and
/// report honestly".
pub async fn ensure_members_reachable(
    rest: &RestClient,
    keys: &Keys,
    channel_id: Uuid,
    swarm: &LeaderSwarm,
) -> Vec<String> {
    use nostr::{Alphabet, SingleLetterTag};

    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(
            buzz_core::kind::KIND_NIP29_GROUP_MEMBERS as u16,
        ))
        .custom_tags(
            SingleLetterTag::lowercase(Alphabet::D),
            [channel_id.to_string()],
        )
        .limit(4);
    let snapshot =
        tokio::time::timeout(std::time::Duration::from_secs(3), rest.query(&[filter])).await;
    let present = match snapshot {
        Ok(Ok(value)) => value.as_array().and_then(|arr| members_from_39002(arr)),
        _ => None,
    };
    let Some(present) = present else {
        tracing::debug!(
            target: "swarm::deploy",
            channel = %channel_id,
            "membership snapshot unavailable — skipping member deployment"
        );
        return Vec::new();
    };

    let missing = missing_members(swarm, &present);
    if missing.is_empty() {
        return Vec::new();
    }
    if missing.len() > MAX_ADDS_PER_TURN {
        tracing::warn!(
            target: "swarm::deploy",
            missing = missing.len(),
            cap = MAX_ADDS_PER_TURN,
            "swarm has more unreachable members than the per-turn add cap"
        );
    }

    let mut unreachable: Vec<String> = Vec::new();
    for member in missing.iter().take(MAX_ADDS_PER_TURN) {
        let added = add_member(rest, keys, channel_id, member).await;
        match added {
            Ok(()) => {
                tracing::info!(
                    target: "swarm::deploy",
                    channel = %channel_id,
                    member = %&member[..member.len().min(8)],
                    swarm = %swarm.id,
                    "swarm member deployed to channel"
                );
            }
            Err(reason) => {
                tracing::warn!(
                    target: "swarm::deploy",
                    channel = %channel_id,
                    member = %&member[..member.len().min(8)],
                    "swarm member add declined: {reason}"
                );
                unreachable.push(member.clone());
            }
        }
    }
    unreachable.extend(missing.iter().skip(MAX_ADDS_PER_TURN).cloned());
    unreachable
}

async fn add_member(
    rest: &RestClient,
    keys: &Keys,
    channel_id: Uuid,
    member_hex: &str,
) -> Result<(), String> {
    let builder =
        buzz_sdk::build_add_member(channel_id, member_hex, Some(buzz_sdk::MemberRole::Bot))
            .map_err(|e| format!("build failed: {e}"))?;
    let event = builder
        .sign_with_keys(keys)
        .map_err(|e| format!("sign failed: {e}"))?;
    let response =
        tokio::time::timeout(std::time::Duration::from_secs(4), rest.submit_event(&event))
            .await
            .map_err(|_| "submit timed out".to_string())?
            .map_err(|e| format!("submit failed: {e}"))?;

    let accepted = response
        .get("accepted")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if accepted {
        Ok(())
    } else {
        let message = response
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("relay rejected the add");
        Err(message.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_sdk::swarm::{SwarmContent, SwarmMember};
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use std::collections::HashMap;

    fn swarm_with(members: &[&Keys]) -> LeaderSwarm {
        LeaderSwarm {
            id: "s-1".into(),
            content: SwarmContent {
                members: Some(
                    members
                        .iter()
                        .map(|keys| SwarmMember {
                            pubkey: keys.public_key().to_hex(),
                            description: None,
                        })
                        .collect(),
                ),
                ..Default::default()
            },
            member_meta: HashMap::new(),
        }
    }

    fn members_event(signer: &Keys, members: &[&Keys], created_at: u64) -> serde_json::Value {
        let tags: Vec<Tag> = members
            .iter()
            .map(|keys| Tag::parse(["p", &keys.public_key().to_hex()]).unwrap())
            .collect();
        let event = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_NIP29_GROUP_MEMBERS as u16),
            "",
        )
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(signer)
        .unwrap();
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn members_from_39002_takes_newest_verifiable_roster() {
        let relay = Keys::generate();
        let old_member = Keys::generate();
        let new_member = Keys::generate();

        let arr = vec![
            members_event(&relay, &[&old_member], 100),
            members_event(&relay, &[&new_member], 200),
            serde_json::json!({"not": "an event"}),
        ];
        let present = members_from_39002(&arr).unwrap();
        assert!(present.contains(&new_member.public_key().to_hex().to_lowercase()));
        assert!(!present.contains(&old_member.public_key().to_hex().to_lowercase()));

        assert!(members_from_39002(&[]).is_none());
        assert!(members_from_39002(&[serde_json::json!("garbage")]).is_none());
    }

    #[test]
    fn missing_members_diffs_roster_against_definition() {
        let in_channel = Keys::generate();
        let absent = Keys::generate();
        let swarm = swarm_with(&[&in_channel, &absent, &absent]);

        let present: HashSet<String> = [in_channel.public_key().to_hex().to_lowercase()].into();
        let missing = missing_members(&swarm, &present);
        assert_eq!(
            missing,
            vec![absent.public_key().to_hex().to_lowercase()],
            "deduped, present members excluded"
        );

        assert!(missing_members(&swarm_with(&[]), &present).is_empty());
    }
}
