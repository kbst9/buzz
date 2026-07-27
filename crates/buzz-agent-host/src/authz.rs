//! Request authorization.
//!
//! Checks, in order, all cheap:
//!
//! 1. **Freshness** — frames outside a ±5 minute window are dropped
//!    (mirrors the relay's own observer-frame policy).
//! 2. **Membership** — the sender must appear in the relay's NIP-43
//!    membership snapshot (kind 13534). The relay's NIP-42 gate already
//!    enforces this at ingest; this re-check defends against roster drift
//!    between admission and processing.
//! 3. **Policy** — if the host configures an allowlist, the sender must be
//!    on it.
//! 4. **Ownership** — mutating ops on an existing agent require the sender
//!    to be the recorded owner; `grant` additionally verifies the NIP-OA
//!    auth tag binds (agent, sender) via the same `buzz_sdk` function the
//!    relay uses.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use nostr::{Event, PublicKey};

use crate::config::HostPolicy;
use crate::state::AgentRecord;
use crate::HostError;

/// Accepted clock skew for control frames, seconds.
const FRESHNESS_WINDOW_SECS: u64 = 300;

/// Reject frames outside the freshness window.
pub fn check_freshness(event: &Event) -> Result<(), HostError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let ts = event.created_at.as_secs() as i64;
    if (ts - now).unsigned_abs() > FRESHNESS_WINDOW_SECS {
        return Err(HostError::Rejected(
            "control frame timestamp outside ±5 minute freshness window".into(),
        ));
    }
    Ok(())
}

/// A parsed membership roster from the kind 13534 snapshot.
#[derive(Debug, Clone, Default)]
pub struct Roster {
    members: HashSet<String>,
}

impl Roster {
    /// Parse the roster from a kind 13534 snapshot's `member` tags.
    pub fn from_snapshot(event: &Event) -> Self {
        let mut members = HashSet::new();
        for tag in event.tags.iter() {
            let parts = tag.as_slice();
            if parts.len() >= 2 && parts[0].as_str() == "member" {
                members.insert(parts[1].as_str().to_lowercase());
            }
        }
        Self { members }
    }

    /// True when the pubkey is a current member.
    pub fn contains(&self, pubkey: &PublicKey) -> bool {
        self.members.contains(&pubkey.to_hex())
    }

    /// Number of members in the roster.
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// True when the roster is empty (no snapshot parsed).
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }
}

/// Membership + allowlist gate for a sender.
pub fn check_sender(
    sender: &PublicKey,
    roster: &Roster,
    policy: &HostPolicy,
) -> Result<(), HostError> {
    if !roster.contains(sender) {
        return Err(HostError::Rejected(
            "sender is not a current community member".into(),
        ));
    }
    if !policy.allowlist.is_empty() {
        let sender_hex = sender.to_hex();
        if !policy
            .allowlist
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&sender_hex))
        {
            return Err(HostError::Rejected(
                "sender is not on this host's allowlist".into(),
            ));
        }
    }
    Ok(())
}

/// Ownership gate: the sender must be the recorded owner of the agent.
pub fn check_owner(sender: &PublicKey, record: &AgentRecord) -> Result<(), HostError> {
    if !record.owner.eq_ignore_ascii_case(&sender.to_hex()) {
        return Err(HostError::Rejected(
            "sender is not the owner of this agent".into(),
        ));
    }
    Ok(())
}

/// Grant gate: verify the NIP-OA auth tag against the agent pubkey and
/// require that the owner it names is the sender.
pub fn check_grant(
    sender: &PublicKey,
    agent_pubkey: &PublicKey,
    auth_tag_json: &str,
) -> Result<(), HostError> {
    let owner = buzz_sdk::nip_oa::verify_auth_tag(auth_tag_json, agent_pubkey)
        .map_err(|e| HostError::Rejected(format!("auth tag verification failed: {e}")))?;
    if owner != *sender {
        return Err(HostError::Rejected(
            "auth tag owner does not match request sender".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn snapshot_with(members: &[&PublicKey]) -> Event {
        let relay = Keys::generate();
        let tags: Vec<Tag> = members
            .iter()
            .map(|p| Tag::parse(["member", &p.to_hex(), "member"]).unwrap())
            .collect();
        EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_NIP43_MEMBERSHIP_LIST as u16),
            "",
        )
        .tags(tags)
        .sign_with_keys(&relay)
        .unwrap()
    }

    #[test]
    fn roster_parses_member_tags() {
        let alice = Keys::generate();
        let bob = Keys::generate();
        let roster =
            Roster::from_snapshot(&snapshot_with(&[&alice.public_key(), &bob.public_key()]));
        assert_eq!(roster.len(), 2);
        assert!(roster.contains(&alice.public_key()));
        let carol = Keys::generate();
        assert!(!roster.contains(&carol.public_key()));
    }

    #[test]
    fn check_sender_enforces_membership_and_allowlist() {
        let alice = Keys::generate();
        let bob = Keys::generate();
        let roster =
            Roster::from_snapshot(&snapshot_with(&[&alice.public_key(), &bob.public_key()]));

        let open = HostPolicy::default();
        assert!(check_sender(&alice.public_key(), &roster, &open).is_ok());

        let carol = Keys::generate();
        assert!(check_sender(&carol.public_key(), &roster, &open).is_err());

        let restricted = HostPolicy {
            allowlist: vec![alice.public_key().to_hex()],
            ..Default::default()
        };
        assert!(check_sender(&alice.public_key(), &roster, &restricted).is_ok());
        assert!(check_sender(&bob.public_key(), &roster, &restricted).is_err());
    }

    #[test]
    fn check_owner_binds_sender_to_record() {
        let owner = Keys::generate();
        let record = crate::state::AgentRecord {
            pubkey: "ab".repeat(32),
            owner: owner.public_key().to_hex(),
            config: buzz_core::host::HostAgentConfig {
                label: "x".into(),
                runtime: "claude".into(),
                system_prompt: None,
                model: None,
                provider: None,
                env: Default::default(),
            },
            auth_tag: None,
            desired_run: false,
            created_at: 0,
        };
        assert!(check_owner(&owner.public_key(), &record).is_ok());
        let stranger = Keys::generate();
        assert!(check_owner(&stranger.public_key(), &record).is_err());
    }

    #[test]
    fn check_grant_verifies_tag_and_sender_binding() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let tag = buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "").unwrap();

        assert!(check_grant(&owner.public_key(), &agent.public_key(), &tag).is_ok());

        // A different sender presenting a valid tag is rejected.
        let stranger = Keys::generate();
        assert!(check_grant(&stranger.public_key(), &agent.public_key(), &tag).is_err());

        // A tag for a different agent is rejected.
        let other_agent = Keys::generate();
        assert!(check_grant(&owner.public_key(), &other_agent.public_key(), &tag).is_err());
    }

    #[test]
    fn freshness_rejects_stale_frames() {
        let keys = Keys::generate();
        let stale = EventBuilder::new(Kind::Custom(24300), "x")
            .custom_created_at(nostr::Timestamp::from_secs(1_000_000))
            .sign_with_keys(&keys)
            .unwrap();
        assert!(check_freshness(&stale).is_err());

        let fresh = EventBuilder::new(Kind::Custom(24300), "x")
            .sign_with_keys(&keys)
            .unwrap();
        assert!(check_freshness(&fresh).is_ok());
    }
}
