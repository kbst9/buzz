//! Assignment watches — structural report-back for swarm leaders
//! (docs/swarms.md §8).
//!
//! The supervisor watches; the worker stays dumb. When this agent (as a
//! swarm leader with `report_back: true`) posts an assignment into a
//! swarm-tagged thread, the harness arms a watch: one live relay
//! subscription on that thread, bypassing the mention filter for exactly
//! one thread for exactly as long as the assignment is open. The assigned
//! member's plain reply — no mention required — fires an evaluation turn.
//!
//! Everything decision-shaped lives here as pure functions; the event loop
//! contributes only thin glue (arm hook on self-authored events, one select
//! branch for watched events, an expiry sweep on the existing tick).
//! Watches are in-memory and die on restart or reconnect (same live-only
//! stance as mention replay — documented in the design).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nostr::Event;
use uuid::Uuid;

use crate::swarm_fetch::LeaderSwarm;

/// How long an assignment stays supervised before the watch expires.
pub const WATCH_TTL: Duration = Duration::from_secs(30 * 60);

/// Concurrent-watch cap; oldest is evicted with a warn beyond this.
pub const WATCH_CAP: usize = 16;

/// Subscription-id prefix for watch REQs. The channel UUID is embedded so
/// the relay dispatcher can route watched events without extra state:
/// `swarmwatch-<channel-uuid>-<root-hex-prefix>`.
pub const WATCH_SUB_PREFIX: &str = "swarmwatch-";

/// One armed assignment watch.
#[derive(Debug, Clone)]
pub struct AssignmentWatch {
    /// Thread root event id (hex) — the client-built swarm-tagged message.
    pub thread_root: String,
    pub channel_id: Uuid,
    pub swarm_id: String,
    /// Normalized (lowercase hex) pubkeys of the members this assignment
    /// mentioned — the only authors whose replies fire the leader.
    pub members: Vec<String>,
    pub armed_at: Instant,
}

/// Subscription id for a watch (channel embedded for dispatch routing).
pub fn watch_sub_id(channel_id: Uuid, thread_root_hex: &str) -> String {
    let root8 = &thread_root_hex[..thread_root_hex.len().min(8)];
    format!("{WATCH_SUB_PREFIX}{channel_id}-{root8}")
}

/// Parse the channel UUID back out of a watch subscription id.
pub fn parse_watch_sub_channel(sub_id: &str) -> Option<Uuid> {
    let rest = sub_id.strip_prefix(WATCH_SUB_PREFIX)?;
    // UUIDs are 36 chars; the root suffix follows after a hyphen.
    Uuid::parse_str(rest.get(..36)?).ok()
}

/// Decide whether a SELF-AUTHORED message arms a watch.
///
/// Requirements (all mechanical, none model-typed):
/// - the message replies into a thread whose ROOT id is known (NIP-10),
/// - the root's `["swarm", <id>]` names a swarm this agent leads
///   (the caller resolves the root's swarm id — it must fetch the root
///   event; a fetch failure means "don't arm", fail-open),
/// - that swarm has `report_back: true`,
/// - the message p-tags at least one member of that swarm.
///
/// Returns the members this assignment addressed (normalized).
pub fn assignment_members(own_event: &Event, root_swarm: &LeaderSwarm) -> Vec<String> {
    if root_swarm.content.report_back != Some(true) {
        return Vec::new();
    }
    let member_set: Vec<String> = root_swarm
        .content
        .members
        .iter()
        .flatten()
        .map(|member| member.pubkey.to_lowercase())
        .collect();
    let mut assigned: Vec<String> = Vec::new();
    for tag in own_event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() >= 2 && parts[0] == "p" {
            let mentioned = parts[1].to_lowercase();
            if member_set.contains(&mentioned) && !assigned.contains(&mentioned) {
                assigned.push(mentioned);
            }
        }
    }
    assigned
}

/// True when a watched-thread event is a member report for this watch.
pub fn is_member_report(event: &Event, watch: &AssignmentWatch, self_hex: &str) -> bool {
    let author = event.pubkey.to_hex().to_lowercase();
    author != self_hex.to_lowercase() && watch.members.contains(&author)
}

/// Fired-watch marks, shared with the prompt path: event id (hex) →
/// swarm id. The pool consumes a mark exactly once to render the
/// REPORT-RECEIVED variant of the `[Swarm Leader]` section for a turn
/// whose trigger carries no swarm tag of its own.
#[derive(Debug, Default, Clone)]
pub struct WatchFiredMarks {
    marks: Arc<Mutex<HashMap<String, String>>>,
}

impl WatchFiredMarks {
    pub fn mark(&self, event_id_hex: String, swarm_id: String) {
        let mut marks = self
            .marks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        marks.insert(event_id_hex, swarm_id);
        // Bounded: marks are consumed by the very next prompt build for
        // that event; anything older than the cap is stale (dropped turn).
        if marks.len() > 64 {
            let excess: Vec<String> = marks.keys().take(marks.len() - 64).cloned().collect();
            for key in excess {
                marks.remove(&key);
            }
        }
    }

    /// Consume the mark for this event, if any.
    pub fn take(&self, event_id_hex: &str) -> Option<String> {
        self.marks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(event_id_hex)
    }
}

/// Loop-owned registry of armed watches (the event loop is single-task, so
/// no interior locking; only [`WatchFiredMarks`] crosses task boundaries).
#[derive(Debug, Default)]
pub struct WatchRegistry {
    watches: Vec<AssignmentWatch>,
}

pub enum ArmOutcome {
    Armed,
    /// Already watching this thread — membership merged, no new REQ needed.
    Merged,
    /// Cap reached: the oldest watch was evicted to make room; the caller
    /// must CLOSE the evicted watch's subscription.
    ArmedEvictingOldest(AssignmentWatch),
}

impl WatchRegistry {
    /// Arm (or extend) a watch. Same-thread re-assignments merge members
    /// instead of stacking subscriptions.
    pub fn arm(&mut self, watch: AssignmentWatch) -> ArmOutcome {
        if let Some(existing) = self
            .watches
            .iter_mut()
            .find(|candidate| candidate.thread_root == watch.thread_root)
        {
            for member in watch.members {
                if !existing.members.contains(&member) {
                    existing.members.push(member);
                }
            }
            existing.armed_at = watch.armed_at;
            return ArmOutcome::Merged;
        }
        if self.watches.len() >= WATCH_CAP {
            let evicted = self.watches.remove(0);
            self.watches.push(watch);
            return ArmOutcome::ArmedEvictingOldest(evicted);
        }
        self.watches.push(watch);
        ArmOutcome::Armed
    }

    /// The watch owning this thread root, if armed.
    pub fn for_thread(&self, thread_root_hex: &str) -> Option<&AssignmentWatch> {
        self.watches
            .iter()
            .find(|watch| watch.thread_root == thread_root_hex)
    }

    /// Close a watch (report received). Returns it for unsubscription.
    pub fn close(&mut self, thread_root_hex: &str) -> Option<AssignmentWatch> {
        let index = self
            .watches
            .iter()
            .position(|watch| watch.thread_root == thread_root_hex)?;
        Some(self.watches.remove(index))
    }

    /// Remove and return every watch older than [`WATCH_TTL`].
    pub fn expire(&mut self, now: Instant) -> Vec<AssignmentWatch> {
        let (expired, kept): (Vec<_>, Vec<_>) = self
            .watches
            .drain(..)
            .partition(|watch| now.duration_since(watch.armed_at) >= WATCH_TTL);
        self.watches = kept;
        expired
    }

    /// Drop every watch (reconnect/shutdown). Returns them for CLOSE frames
    /// when the connection still exists.
    pub fn drain_all(&mut self) -> Vec<AssignmentWatch> {
        self.watches.drain(..).collect()
    }

    pub fn len(&self) -> usize {
        self.watches.len()
    }

    pub fn is_empty(&self) -> bool {
        self.watches.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_sdk::swarm::{SwarmContent, SwarmMember};
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use std::collections::HashMap as StdHashMap;

    fn swarm(leader: &Keys, member: &Keys, report_back: bool) -> LeaderSwarm {
        LeaderSwarm {
            id: "s-1".into(),
            content: SwarmContent {
                name: Some("devswarm".into()),
                leader_pubkey: Some(leader.public_key().to_hex()),
                instructions: None,
                members: Some(vec![SwarmMember {
                    pubkey: member.public_key().to_hex(),
                    description: None,
                }]),
                report_back: Some(report_back),
                evaluation_criteria: Some("tests pass".into()),
                extra: Default::default(),
            },
            member_meta: StdHashMap::new(),
        }
    }

    fn signed(keys: &Keys, ptag: Option<&Keys>) -> Event {
        let mut tags: Vec<Tag> = vec![];
        if let Some(target) = ptag {
            tags.push(Tag::parse(["p", &target.public_key().to_hex()]).unwrap());
        }
        EventBuilder::new(Kind::Custom(9), "assignment text")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn watch_for(member: &Keys) -> AssignmentWatch {
        AssignmentWatch {
            thread_root: "root1".into(),
            channel_id: Uuid::new_v4(),
            swarm_id: "s-1".into(),
            members: vec![member.public_key().to_hex().to_lowercase()],
            armed_at: Instant::now(),
        }
    }

    #[test]
    fn assignment_members_requires_reporting_and_member_mention() {
        let leader = Keys::generate();
        let member = Keys::generate();
        let outsider = Keys::generate();

        let on = swarm(&leader, &member, true);
        let off = swarm(&leader, &member, false);

        let mentions_member = signed(&leader, Some(&member));
        let mentions_outsider = signed(&leader, Some(&outsider));
        let mentions_nobody = signed(&leader, None);

        assert_eq!(assignment_members(&mentions_member, &on).len(), 1);
        assert!(assignment_members(&mentions_member, &off).is_empty());
        assert!(assignment_members(&mentions_outsider, &on).is_empty());
        assert!(assignment_members(&mentions_nobody, &on).is_empty());
    }

    #[test]
    fn member_report_predicate_ignores_self_and_strangers() {
        let leader = Keys::generate();
        let member = Keys::generate();
        let stranger = Keys::generate();
        let watch = watch_for(&member);
        let self_hex = leader.public_key().to_hex();

        assert!(is_member_report(&signed(&member, None), &watch, &self_hex));
        assert!(!is_member_report(&signed(&leader, None), &watch, &self_hex));
        assert!(!is_member_report(
            &signed(&stranger, None),
            &watch,
            &self_hex
        ));
    }

    #[test]
    fn registry_merges_same_thread_and_evicts_at_cap() {
        let member_a = Keys::generate();
        let member_b = Keys::generate();
        let mut registry = WatchRegistry::default();

        let mut first = watch_for(&member_a);
        first.thread_root = "shared-root".into();
        assert!(matches!(registry.arm(first), ArmOutcome::Armed));

        let mut second = watch_for(&member_b);
        second.thread_root = "shared-root".into();
        assert!(matches!(registry.arm(second), ArmOutcome::Merged));
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.for_thread("shared-root").unwrap().members.len(), 2);

        for index in 0..WATCH_CAP {
            let mut watch = watch_for(&member_a);
            watch.thread_root = format!("root-{index}");
            registry.arm(watch);
        }
        assert_eq!(registry.len(), WATCH_CAP);
        let mut overflow = watch_for(&member_a);
        overflow.thread_root = "overflow-root".into();
        assert!(matches!(
            registry.arm(overflow),
            ArmOutcome::ArmedEvictingOldest(_)
        ));
        assert_eq!(registry.len(), WATCH_CAP);
    }

    #[test]
    fn registry_expiry_and_close() {
        let member = Keys::generate();
        let mut registry = WatchRegistry::default();
        let mut old = watch_for(&member);
        old.thread_root = "old".into();
        old.armed_at = Instant::now() - WATCH_TTL - Duration::from_secs(1);
        let mut fresh = watch_for(&member);
        fresh.thread_root = "fresh".into();
        registry.arm(old);
        registry.arm(fresh);

        let expired = registry.expire(Instant::now());
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].thread_root, "old");
        assert_eq!(registry.len(), 1);

        assert!(registry.close("fresh").is_some());
        assert!(registry.is_empty());
    }

    #[test]
    fn marks_consume_once_and_stay_bounded() {
        let marks = WatchFiredMarks::default();
        marks.mark("ev1".into(), "s-1".into());
        assert_eq!(marks.take("ev1").as_deref(), Some("s-1"));
        assert_eq!(marks.take("ev1"), None);

        for index in 0..80 {
            marks.mark(format!("ev-{index}"), "s".into());
        }
        let live = (0..80)
            .filter(|index| marks.take(&format!("ev-{index}")).is_some())
            .count();
        assert!(live <= 64, "marks must stay bounded, kept {live}");
    }

    #[test]
    fn watch_sub_id_round_trips_channel() {
        let channel = Uuid::new_v4();
        let sub = watch_sub_id(channel, &"ab".repeat(32));
        assert!(sub.starts_with(WATCH_SUB_PREFIX));
        assert_eq!(parse_watch_sub_channel(&sub), Some(channel));
        assert_eq!(parse_watch_sub_channel("swarmwatch-notauuid-x"), None);
        assert_eq!(parse_watch_sub_channel("ch-something"), None);
    }
}
