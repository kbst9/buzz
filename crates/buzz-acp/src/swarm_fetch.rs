//! Fetch the swarms this agent leads (kind:30178) and render the
//! `[Swarm Leader]` prompt section for swarm-addressed turns.
//!
//! Mirrors `definition_fetch`: owner-authored events only, one bounded query
//! when a new session is born, fail-open on errors (a relay outage keeps the
//! cached directory), confirmed absence clears it. Additionally resolves
//! member display names/bios from kind:0 at refresh time so turn-time
//! rendering is pure and instant.
//!
//! A turn is swarm-addressed when the triggering event both p-tags this
//! agent AND carries a `["swarm", <id>]` tag naming a definition this agent
//! leads (see docs/swarms.md — mention aliasing). A plain mention without
//! the tag never activates leader mode, so leaders remain usable as
//! ordinary agents.

use std::collections::HashMap;
use std::sync::RwLock;

use buzz_core::kind::KIND_SWARM;
use buzz_sdk::swarm::{parse_swarm_content, SwarmContent, SWARM_TAG};
use nostr::{Alphabet, Event, PublicKey, SingleLetterTag};

use crate::relay::RestClient;

/// One swarm this agent leads, with member metadata pre-resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct LeaderSwarm {
    /// The swarm's stable id (the event's `d` tag).
    pub id: String,
    pub content: SwarmContent,
    /// kind:0-derived metadata per member pubkey (display name, about).
    pub member_meta: HashMap<String, MemberMeta>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemberMeta {
    pub display_name: Option<String>,
    pub about: Option<String>,
}

/// Agent-global cache of the swarms this agent leads.
#[derive(Debug, Default)]
pub struct SwarmDirectoryCache {
    swarms: RwLock<Vec<LeaderSwarm>>,
}

impl SwarmDirectoryCache {
    /// The cached swarm with this id, if this agent leads it.
    pub fn get(&self, swarm_id: &str) -> Option<LeaderSwarm> {
        self.swarms
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|swarm| swarm.id == swarm_id)
            .cloned()
    }

    /// True when the agent leads at least one swarm (cheap telemetry).
    pub fn leads_any(&self) -> bool {
        !self
            .swarms
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }

    /// Refresh from the relay: owner-authored kind:30178 heads whose
    /// `leader_pubkey` is this agent, plus member kind:0 metadata.
    ///
    /// Same overwrite discipline as `DefinitionPromptCache::refresh`:
    /// definitive answers (including confirmed absence) replace the cache;
    /// fetch errors keep it.
    pub async fn refresh(&self, rest: &RestClient, agent: &PublicKey, owner: &PublicKey) {
        match fetch_leader_swarms(rest, agent, owner).await {
            Ok(next) => {
                let mut swarms = self
                    .swarms
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if *swarms != next {
                    tracing::info!(
                        target: "swarm::directory",
                        count = next.len(),
                        "leader swarm directory updated"
                    );
                }
                *swarms = next;
            }
            Err(reason) => {
                tracing::warn!(
                    target: "swarm::directory",
                    "swarm fetch failed: {reason} — keeping cached directory"
                );
            }
        }
    }
}

/// Extract the swarm id from a triggering event's `["swarm", <id>]` tag.
pub fn event_swarm_tag(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == SWARM_TAG).then(|| parts[1].clone())
    })
}

/// True when `event` p-tags `agent` — the second half of the
/// swarm-addressing predicate (belt-and-suspenders next to the mention
/// filter, which `--subscribe-mode all` operators may have disabled).
pub fn event_mentions(event: &Event, agent: &PublicKey) -> bool {
    let agent_hex = agent.to_hex();
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.len() >= 2 && parts[0] == "p" && parts[1].eq_ignore_ascii_case(&agent_hex)
    })
}

async fn fetch_leader_swarms(
    rest: &RestClient,
    agent: &PublicKey,
    owner: &PublicKey,
) -> Result<Vec<LeaderSwarm>, String> {
    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(KIND_SWARM as u16))
        .author(*owner)
        .limit(64);
    let value = rest
        .query(&[filter])
        .await
        .map_err(|e| format!("relay query failed: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "relay query returned non-array".to_string())?;
    let mut swarms = decode_leader_swarms(arr, agent, owner)?;

    // Resolve member metadata (best-effort; absence renders as pubkey-only
    // roster lines rather than failing the refresh).
    let member_pubkeys: Vec<PublicKey> = swarms
        .iter()
        .flat_map(|swarm| swarm.content.members.iter().flatten())
        .filter_map(|member| PublicKey::from_hex(&member.pubkey).ok())
        .collect();
    if !member_pubkeys.is_empty() {
        let meta = fetch_member_meta(rest, &member_pubkeys).await;
        for swarm in &mut swarms {
            swarm.member_meta = meta.clone();
        }
    }
    Ok(swarms)
}

/// Pure decoder: NIP-33 head per `d` tag among verified owner-authored
/// kind:30178 events, kept when `leader_pubkey` is this agent.
///
/// - Empty array → confirmed absence (`Ok(vec![])`).
/// - Non-empty array with zero verifiable candidates → `Err` (fail closed).
/// - Heads that parse but name a different leader are simply not ours —
///   they don't make the result an error.
pub fn decode_leader_swarms(
    arr: &[serde_json::Value],
    agent: &PublicKey,
    owner: &PublicKey,
) -> Result<Vec<LeaderSwarm>, String> {
    if arr.is_empty() {
        return Ok(Vec::new());
    }
    let mut heads: HashMap<String, Event> = HashMap::new();
    let mut any_verifiable = false;
    for ev_json in arr {
        let event: Event = match serde_json::from_value(ev_json.clone()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if event.verify().is_err() || event.pubkey != *owner {
            continue;
        }
        if event.kind.as_u16() as u32 != KIND_SWARM {
            continue;
        }
        let Some(d_tag) = event.tags.identifier().map(str::to_string) else {
            continue;
        };
        any_verifiable = true;
        // NIP-01 replaceable rule: newest created_at wins, ties → lowest id.
        match heads.entry(d_tag) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(event);
            }
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                let current = slot.get();
                let newer = event.created_at > current.created_at
                    || (event.created_at == current.created_at && event.id < current.id);
                if newer {
                    slot.insert(event);
                }
            }
        }
    }
    if heads.is_empty() && !any_verifiable {
        return Err(
            "relay returned swarm candidate(s) but none were verifiable owner-authored events"
                .to_string(),
        );
    }

    let agent_hex = agent.to_hex();
    let mut swarms: Vec<LeaderSwarm> = Vec::new();
    for (id, event) in heads {
        let Ok(content) = parse_swarm_content(event.content.as_ref()) else {
            continue;
        };
        let leads = content
            .leader_pubkey
            .as_deref()
            .is_some_and(|leader| leader.eq_ignore_ascii_case(&agent_hex));
        if leads {
            swarms.push(LeaderSwarm {
                id,
                content,
                member_meta: HashMap::new(),
            });
        }
    }
    swarms.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(swarms)
}

/// Batch-resolve member kind:0 profiles into display metadata. Best-effort:
/// any failure yields an empty map.
async fn fetch_member_meta(
    rest: &RestClient,
    members: &[PublicKey],
) -> HashMap<String, MemberMeta> {
    #[derive(serde::Deserialize, Default)]
    struct ProfileFields {
        #[serde(default)]
        display_name: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        about: Option<String>,
    }

    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Metadata)
        .authors(members.iter().copied())
        .limit((members.len() * 2).max(8));
    let Ok(value) = rest.query(&[filter]).await else {
        return HashMap::new();
    };
    let Some(arr) = value.as_array() else {
        return HashMap::new();
    };
    let mut newest: HashMap<String, (u64, MemberMeta)> = HashMap::new();
    for ev_json in arr {
        let Ok(event) = serde_json::from_value::<Event>(ev_json.clone()) else {
            continue;
        };
        if event.verify().is_err() {
            continue;
        }
        let fields: ProfileFields =
            serde_json::from_str(event.content.as_ref()).unwrap_or_default();
        let meta = MemberMeta {
            display_name: fields
                .display_name
                .or(fields.name)
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty()),
            about: fields
                .about
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty()),
        };
        let key = event.pubkey.to_hex();
        let ts = event.created_at.as_u64();
        match newest.get(&key) {
            Some((existing_ts, _)) if *existing_ts >= ts => {}
            _ => {
                newest.insert(key, (ts, meta));
            }
        }
    }
    newest
        .into_iter()
        .map(|(pubkey, (_, meta))| (pubkey, meta))
        .collect()
}

/// How a swarm-leader turn was triggered — picks the section framing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwarmTurnMode {
    /// The triggering event addressed the swarm (mention + swarm tag).
    Assigned,
    /// An assignment watch fired: a member reported back in a supervised
    /// thread (docs/swarms.md §8).
    ReportReceived,
}

/// Render the `[Swarm Leader]` section for a swarm-addressed turn.
///
/// Assembly order inside the section (high → low priority, per
/// docs/swarms.md §4): built-in leader template, owner instructions,
/// member roster, reporting policy. `mode` swaps only the lead framing:
/// [`SwarmTurnMode::ReportReceived`] frames the turn as evaluating a member
/// report and omits the assignment/reporting sentences.
pub fn render_swarm_leader_section(swarm: &LeaderSwarm, mode: SwarmTurnMode) -> String {
    let name = swarm
        .content
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(&swarm.id);
    let report_back = swarm.content.report_back.unwrap_or(false);

    let mut out = String::new();
    out.push_str("[Swarm Leader]\n");
    match mode {
        SwarmTurnMode::Assigned => {
            out.push_str(&format!(
                "This message addresses the swarm \"{name}\", which you lead. Your job is to \
                 attribute the task to exactly ONE member below by @-mentioning them in a reply \
                 in this thread — NEVER do the work yourself. Restate the task crisply for the \
                 member you pick. If a member already answered in this thread, evaluate or \
                 reassign with feedback instead of redoing the work.\n"
            ));
            if report_back {
                out.push_str(
                    "Reporting is ON: end every assignment by requiring the member to reply IN \
                     THIS THREAD when the work is complete — their reply is picked up \
                     automatically; do NOT ask them to mention you. When a member reports back, \
                     evaluate the result against the evaluation criteria below, then either \
                     confirm completion to the original requester or reassign with concrete \
                     feedback.\n",
                );
            }
        }
        SwarmTurnMode::ReportReceived => {
            out.push_str(
                "A member you assigned in this thread has replied — this is their report. \
                 Evaluate it against the evaluation criteria below, then either confirm \
                 completion to the original requester or reassign to a member with concrete \
                 feedback. Do NOT redo the work yourself.\n",
            );
        }
    }
    if let Some(instructions) = swarm
        .content
        .instructions
        .as_deref()
        .map(str::trim)
        .filter(|i| !i.is_empty())
    {
        out.push_str("\nLeader instructions (high priority):\n");
        out.push_str(instructions);
        out.push('\n');
    }

    out.push_str("\nSwarm members:\n");
    for member in swarm.content.members.iter().flatten() {
        let meta = swarm.member_meta.get(&member.pubkey.to_lowercase());
        let display = meta
            .and_then(|m| m.display_name.as_deref())
            .unwrap_or("unknown");
        out.push_str(&format!("- @{display} (pubkey {})", member.pubkey));
        if let Some(desc) = member
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            out.push_str(&format!(" — assign: {desc}"));
        }
        if let Some(about) = meta.and_then(|m| m.about.as_deref()) {
            out.push_str(&format!(" — bio: {about}"));
        }
        out.push('\n');
    }

    if report_back {
        if let Some(criteria) = swarm
            .content
            .evaluation_criteria
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            out.push_str("\nEvaluation criteria:\n");
            out.push_str(criteria);
            out.push('\n');
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_sdk::swarm::{build_swarm_definition, SwarmMember};
    use nostr::{Keys, Timestamp};

    fn signed_swarm(owner: &Keys, d_tag: &str, content: &SwarmContent, created_at: u64) -> Event {
        build_swarm_definition(d_tag, content)
            .unwrap()
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(owner)
            .expect("sign swarm event")
    }

    fn swarm_content(leader: &Keys, member: &Keys) -> SwarmContent {
        SwarmContent {
            name: Some("devswarm".into()),
            leader_pubkey: Some(leader.public_key().to_hex()),
            instructions: Some("Small diffs only.".into()),
            members: Some(vec![SwarmMember {
                pubkey: member.public_key().to_hex(),
                description: Some("do bug fixes".into()),
            }]),
            report_back: Some(true),
            evaluation_criteria: Some("Tests pass.".into()),
            extra: Default::default(),
        }
    }

    #[test]
    fn decode_empty_is_confirmed_absence() {
        let agent = Keys::generate();
        let owner = Keys::generate();
        let out = decode_leader_swarms(&[], &agent.public_key(), &owner.public_key()).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn decode_keeps_only_swarms_this_agent_leads() {
        let owner = Keys::generate();
        let leader = Keys::generate();
        let member = Keys::generate();
        let other_leader = Keys::generate();

        let mine = signed_swarm(&owner, "s-mine", &swarm_content(&leader, &member), 100);
        let theirs = signed_swarm(
            &owner,
            "s-theirs",
            &swarm_content(&other_leader, &member),
            100,
        );
        let arr = vec![
            serde_json::to_value(&mine).unwrap(),
            serde_json::to_value(&theirs).unwrap(),
        ];
        let out = decode_leader_swarms(&arr, &leader.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "s-mine");
    }

    #[test]
    fn decode_newest_head_per_d_tag_wins() {
        let owner = Keys::generate();
        let leader = Keys::generate();
        let member = Keys::generate();
        let mut old_content = swarm_content(&leader, &member);
        old_content.name = Some("old".into());
        let mut new_content = swarm_content(&leader, &member);
        new_content.name = Some("new".into());

        let old = signed_swarm(&owner, "s-1", &old_content, 100);
        let new = signed_swarm(&owner, "s-1", &new_content, 200);
        let arr = vec![
            serde_json::to_value(&old).unwrap(),
            serde_json::to_value(&new).unwrap(),
        ];
        let out = decode_leader_swarms(&arr, &leader.public_key(), &owner.public_key()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content.name.as_deref(), Some("new"));
    }

    #[test]
    fn decode_foreign_author_fails_closed() {
        let owner = Keys::generate();
        let impostor = Keys::generate();
        let leader = Keys::generate();
        let member = Keys::generate();
        let ev = signed_swarm(&impostor, "s-evil", &swarm_content(&leader, &member), 100);
        let arr = vec![serde_json::to_value(&ev).unwrap()];
        let result = decode_leader_swarms(&arr, &leader.public_key(), &owner.public_key());
        assert!(result.is_err(), "expected Err, got: {result:?}");
    }

    #[test]
    fn event_swarm_tag_and_mention_predicates() {
        let owner = Keys::generate();
        let leader = Keys::generate();
        let ev = nostr::EventBuilder::new(nostr::Kind::Custom(9), "@devswarm fix the bug")
            .tags([
                nostr::Tag::parse(["p", &leader.public_key().to_hex()]).unwrap(),
                nostr::Tag::parse([SWARM_TAG, "s-1"]).unwrap(),
            ])
            .sign_with_keys(&owner)
            .unwrap();
        assert_eq!(event_swarm_tag(&ev).as_deref(), Some("s-1"));
        assert!(event_mentions(&ev, &leader.public_key()));
        assert!(!event_mentions(&ev, &Keys::generate().public_key()));
    }

    #[test]
    fn render_section_carries_template_instructions_roster_criteria() {
        let owner = Keys::generate();
        let leader = Keys::generate();
        let member = Keys::generate();
        let content = swarm_content(&leader, &member);
        let mut meta = HashMap::new();
        meta.insert(
            member.public_key().to_hex(),
            MemberMeta {
                display_name: Some("Nova".into()),
                about: Some("Rust specialist".into()),
            },
        );
        let swarm = LeaderSwarm {
            id: "s-1".into(),
            content,
            member_meta: meta,
        };
        let section = render_swarm_leader_section(&swarm, SwarmTurnMode::Assigned);
        assert!(section.starts_with("[Swarm Leader]"));
        assert!(section.contains("devswarm"));
        assert!(section.contains("exactly ONE member"));
        assert!(section.contains("Small diffs only."));
        assert!(section.contains("@Nova"));
        assert!(section.contains("assign: do bug fixes"));
        assert!(section.contains("bio: Rust specialist"));
        assert!(section.contains("Reporting is ON"));
        assert!(section.contains("Tests pass."));
        let _ = owner;
    }

    #[test]
    fn render_section_omits_reporting_when_off() {
        let leader = Keys::generate();
        let member = Keys::generate();
        let mut content = swarm_content(&leader, &member);
        content.report_back = Some(false);
        let swarm = LeaderSwarm {
            id: "s-1".into(),
            content,
            member_meta: HashMap::new(),
        };
        let section = render_swarm_leader_section(&swarm, SwarmTurnMode::Assigned);
        assert!(!section.contains("Reporting is ON"));
        assert!(!section.contains("Evaluation criteria"));
        assert!(section.contains("pubkey"));
    }

    #[test]
    fn render_report_received_frames_evaluation_not_assignment() {
        let leader = Keys::generate();
        let member = Keys::generate();
        let swarm = LeaderSwarm {
            id: "s-1".into(),
            content: swarm_content(&leader, &member),
            member_meta: HashMap::new(),
        };
        let section = render_swarm_leader_section(&swarm, SwarmTurnMode::ReportReceived);
        assert!(section.starts_with("[Swarm Leader]"));
        assert!(section.contains("this is their report"));
        assert!(section.contains("Do NOT redo the work yourself."));
        // Criteria + roster + owner instructions ride along unchanged.
        assert!(section.contains("Evaluation criteria:"));
        assert!(section.contains("Tests pass."));
        assert!(section.contains("Swarm members:"));
        assert!(section.contains("Small diffs only."));
        // The assignment/reporting sentences are Assigned-mode only.
        assert!(!section.contains("exactly ONE member"));
        assert!(!section.contains("Reporting is ON"));
        assert!(!section.contains("end every assignment"));
    }
}
