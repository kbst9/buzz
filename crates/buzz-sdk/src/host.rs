//! Agent-host event builders and frame parsing.
//!
//! Assembles and dissects the two agent-host protocol events:
//!
//! - kind 30178 host announcements (durable, plaintext JSON content)
//! - kind 24300 control frames (ephemeral, NIP-44 encrypted content)
//!
//! Payload types and the encryption envelope live in [`buzz_core::host`];
//! this module owns event/tag assembly, following the SDK convention that
//! builders return an [`nostr::EventBuilder`] for the caller to sign.

use buzz_core::host::{
    decrypt_host_payload, encrypt_host_payload, HostAnnounceContent, HostControlReply,
    HostControlRequest, HostPayloadError, HOST_FRAME_REPLY, HOST_FRAME_REQUEST, HOST_FRAME_TAG,
    HOST_REQ_TAG, HOST_TAG,
};
use buzz_core::kind::{KIND_AGENT_HOST_ANNOUNCE, KIND_AGENT_HOST_CONTROL};
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};

use crate::SdkError;

/// Maximum accepted `d`-tag (host id) length for announcements.
const HOST_ID_MAX_LEN: usize = 64;

fn parse_tag(parts: &[&str]) -> Result<Tag, SdkError> {
    Tag::parse(parts.iter().copied()).map_err(|e| SdkError::InvalidTag(e.to_string()))
}

/// Build a kind 30178 host announcement.
///
/// `host_id` becomes the `d` tag — it must be non-empty, at most 64 chars,
/// and limited to `[a-z0-9_-]` so it can double as a stable slug.
pub fn build_host_announcement(
    host_id: &str,
    content: &HostAnnounceContent,
) -> Result<EventBuilder, SdkError> {
    if host_id.is_empty() || host_id.len() > HOST_ID_MAX_LEN {
        return Err(SdkError::InvalidInput(format!(
            "host id must be 1–{HOST_ID_MAX_LEN} chars"
        )));
    }
    if !host_id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(SdkError::InvalidInput(
            "host id must contain only [a-z0-9_-]".into(),
        ));
    }
    let json = serde_json::to_string(content)
        .map_err(|e| SdkError::InvalidInput(format!("announcement serialization: {e}")))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_HOST_ANNOUNCE as u16), json)
            .tags([parse_tag(&["d", host_id])?]),
    )
}

/// A parsed host announcement.
#[derive(Debug, Clone)]
pub struct HostAnnouncement {
    /// The host's pubkey (event author).
    pub host_pubkey: PublicKey,
    /// The host's stable id (`d` tag).
    pub host_id: String,
    /// Announcement body.
    pub content: HostAnnounceContent,
}

/// Parse and validate a kind 30178 event into a [`HostAnnouncement`].
///
/// Rejects wrong kinds, missing/empty `d` tags, and malformed content.
/// Does NOT verify the event signature — callers receive events from the
/// relay, which has already verified them; re-verify explicitly if the
/// event arrives through an untrusted path.
pub fn parse_host_announcement(event: &Event) -> Result<HostAnnouncement, SdkError> {
    if buzz_core::kind::event_kind_u32(event) != KIND_AGENT_HOST_ANNOUNCE {
        return Err(SdkError::InvalidInput(format!(
            "expected kind {KIND_AGENT_HOST_ANNOUNCE}, got {}",
            buzz_core::kind::event_kind_u32(event)
        )));
    }
    let host_id = event
        .tags
        .iter()
        .find_map(|t| {
            let parts = t.as_slice();
            (parts.len() >= 2 && parts[0].as_str() == "d").then(|| parts[1].as_str().to_string())
        })
        .filter(|d| !d.is_empty())
        .ok_or_else(|| SdkError::InvalidInput("announcement missing d tag".into()))?;
    let content: HostAnnounceContent = serde_json::from_str(&event.content)
        .map_err(|e| SdkError::InvalidInput(format!("announcement content: {e}")))?;
    Ok(HostAnnouncement {
        host_pubkey: event.pubkey,
        host_id,
        content,
    })
}

/// Shared tag assembly for control frames.
fn control_frame_tags(
    recipient: &PublicKey,
    host_pubkey: &PublicKey,
    frame: &str,
    req_id: &str,
) -> Result<Vec<Tag>, SdkError> {
    if req_id.is_empty() || req_id.len() > 64 {
        return Err(SdkError::InvalidInput("req id must be 1–64 chars".into()));
    }
    Ok(vec![
        Tag::public_key(*recipient),
        parse_tag(&[HOST_TAG, &host_pubkey.to_hex()])?,
        parse_tag(&[HOST_FRAME_TAG, frame])?,
        parse_tag(&[HOST_REQ_TAG, req_id])?,
    ])
}

/// Build a kind 24300 control request, owner → host.
///
/// Encrypts `request` to the host with NIP-44 and addresses the frame with
/// `p` = host. The caller signs with the same `sender_keys`.
pub fn build_control_request(
    sender_keys: &Keys,
    host_pubkey: &PublicKey,
    req_id: &str,
    request: &HostControlRequest,
) -> Result<EventBuilder, SdkError> {
    let ciphertext = encrypt_host_payload(sender_keys, host_pubkey, request)
        .map_err(|e| SdkError::InvalidInput(format!("control encrypt: {e}")))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_HOST_CONTROL as u16), ciphertext).tags(
            control_frame_tags(host_pubkey, host_pubkey, HOST_FRAME_REQUEST, req_id)?,
        ),
    )
}

/// Build a kind 24300 control reply, host → requester.
///
/// Encrypts `reply` to the requester with NIP-44 and addresses the frame
/// with `p` = requester. The caller signs with the same `host_keys`.
pub fn build_control_reply(
    host_keys: &Keys,
    requester: &PublicKey,
    req_id: &str,
    reply: &HostControlReply,
) -> Result<EventBuilder, SdkError> {
    let ciphertext = encrypt_host_payload(host_keys, requester, reply)
        .map_err(|e| SdkError::InvalidInput(format!("control encrypt: {e}")))?;
    Ok(
        EventBuilder::new(Kind::Custom(KIND_AGENT_HOST_CONTROL as u16), ciphertext).tags(
            control_frame_tags(requester, &host_keys.public_key(), HOST_FRAME_REPLY, req_id)?,
        ),
    )
}

/// Cleartext routing metadata of a control frame, readable without decrypting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlFrameMeta {
    /// Frame direction.
    pub direction: ControlFrameDirection,
    /// The host pubkey named in the `host` tag.
    pub host_pubkey: PublicKey,
    /// The recipient named in the `p` tag.
    pub recipient: PublicKey,
    /// Correlation id from the `req` tag.
    pub req_id: String,
}

/// Direction of a control frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlFrameDirection {
    /// Owner → host.
    Request,
    /// Host → owner.
    Reply,
}

/// Extract routing metadata from a kind 24300 event without decrypting.
///
/// Returns an error for wrong kinds or missing/malformed routing tags —
/// a frame that fails here should be dropped, not processed.
pub fn control_frame_meta(event: &Event) -> Result<ControlFrameMeta, SdkError> {
    if buzz_core::kind::event_kind_u32(event) != KIND_AGENT_HOST_CONTROL {
        return Err(SdkError::InvalidInput(format!(
            "expected kind {KIND_AGENT_HOST_CONTROL}, got {}",
            buzz_core::kind::event_kind_u32(event)
        )));
    }
    let mut host_hex: Option<String> = None;
    let mut recipient_hex: Option<String> = None;
    let mut frame: Option<String> = None;
    let mut req_id: Option<String> = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() < 2 {
            continue;
        }
        let value = parts[1].as_str();
        match parts[0].as_str() {
            "p" if recipient_hex.is_none() => recipient_hex = Some(value.to_string()),
            HOST_TAG if host_hex.is_none() => host_hex = Some(value.to_string()),
            HOST_FRAME_TAG if frame.is_none() => frame = Some(value.to_string()),
            HOST_REQ_TAG if req_id.is_none() => req_id = Some(value.to_string()),
            _ => {}
        }
    }
    let direction = match frame.as_deref() {
        Some(HOST_FRAME_REQUEST) => ControlFrameDirection::Request,
        Some(HOST_FRAME_REPLY) => ControlFrameDirection::Reply,
        other => {
            return Err(SdkError::InvalidInput(format!(
                "missing or unknown frame tag: {other:?}"
            )))
        }
    };
    let host_pubkey = PublicKey::from_hex(
        host_hex
            .as_deref()
            .ok_or_else(|| SdkError::InvalidInput("missing host tag".into()))?,
    )
    .map_err(|e| SdkError::InvalidInput(format!("invalid host pubkey: {e}")))?;
    let recipient = PublicKey::from_hex(
        recipient_hex
            .as_deref()
            .ok_or_else(|| SdkError::InvalidInput("missing p tag".into()))?,
    )
    .map_err(|e| SdkError::InvalidInput(format!("invalid p tag: {e}")))?;
    let req_id = req_id
        .filter(|r| !r.is_empty())
        .ok_or_else(|| SdkError::InvalidInput("missing req tag".into()))?;
    Ok(ControlFrameMeta {
        direction,
        host_pubkey,
        recipient,
        req_id,
    })
}

/// Decrypt a control request frame as the host.
pub fn decrypt_control_request(
    host_keys: &Keys,
    event: &Event,
) -> Result<HostControlRequest, HostPayloadError> {
    decrypt_host_payload(host_keys, event)
}

/// Decrypt a control reply frame as the requester.
pub fn decrypt_control_reply(
    requester_keys: &Keys,
    event: &Event,
) -> Result<HostControlReply, HostPayloadError> {
    decrypt_host_payload(requester_keys, event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::host::{HostAcceptsFrom, HostAgentConfig, HostCapacity, HostRuntime};

    fn announce_content() -> HostAnnounceContent {
        HostAnnounceContent {
            label: "gradient".into(),
            version: "0.1.0".into(),
            runtimes: vec![HostRuntime {
                id: "claude".into(),
                label: "Claude Code".into(),
            }],
            capacity: HostCapacity {
                max_agents: 32,
                deployed: 0,
            },
            accepts_from: HostAcceptsFrom::Members,
        }
    }

    #[test]
    fn announcement_round_trips() {
        let host = Keys::generate();
        let event = build_host_announcement("gradient", &announce_content())
            .unwrap()
            .sign_with_keys(&host)
            .unwrap();
        let parsed = parse_host_announcement(&event).unwrap();
        assert_eq!(parsed.host_id, "gradient");
        assert_eq!(parsed.host_pubkey, host.public_key());
        assert_eq!(parsed.content, announce_content());
    }

    #[test]
    fn announcement_rejects_bad_host_ids() {
        for bad in ["", "Has Caps", "spaces here", "a/slash", &"x".repeat(65)] {
            assert!(build_host_announcement(bad, &announce_content()).is_err());
        }
    }

    #[test]
    fn parse_announcement_rejects_wrong_kind() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(1), "{}")
            .sign_with_keys(&keys)
            .unwrap();
        assert!(parse_host_announcement(&event).is_err());
    }

    #[test]
    fn control_request_round_trips_end_to_end() {
        let owner = Keys::generate();
        let host = Keys::generate();
        let request = HostControlRequest::Create {
            config: HostAgentConfig {
                label: "researcher".into(),
                runtime: "claude".into(),
                system_prompt: Some("be thorough".into()),
                model: None,
                provider: None,
                env: Default::default(),
            },
        };
        let event = build_control_request(&owner, &host.public_key(), "req-1", &request)
            .unwrap()
            .sign_with_keys(&owner)
            .unwrap();

        let meta = control_frame_meta(&event).unwrap();
        assert_eq!(meta.direction, ControlFrameDirection::Request);
        assert_eq!(meta.host_pubkey, host.public_key());
        assert_eq!(meta.recipient, host.public_key());
        assert_eq!(meta.req_id, "req-1");

        let decrypted = decrypt_control_request(&host, &event).unwrap();
        assert_eq!(decrypted, request);
    }

    #[test]
    fn control_reply_round_trips_end_to_end() {
        let owner = Keys::generate();
        let host = Keys::generate();
        let reply = HostControlReply::Created {
            agent: "ab".repeat(32),
        };
        let event = build_control_reply(&host, &owner.public_key(), "req-1", &reply)
            .unwrap()
            .sign_with_keys(&host)
            .unwrap();

        let meta = control_frame_meta(&event).unwrap();
        assert_eq!(meta.direction, ControlFrameDirection::Reply);
        assert_eq!(meta.host_pubkey, host.public_key());
        assert_eq!(meta.recipient, owner.public_key());

        let decrypted = decrypt_control_reply(&owner, &event).unwrap();
        assert_eq!(decrypted, reply);
    }

    #[test]
    fn wrong_recipient_cannot_decrypt() {
        let owner = Keys::generate();
        let host = Keys::generate();
        let eavesdropper = Keys::generate();
        let event = build_control_request(
            &owner,
            &host.public_key(),
            "req-1",
            &HostControlRequest::Status { agent: None },
        )
        .unwrap()
        .sign_with_keys(&owner)
        .unwrap();
        assert!(decrypt_control_request(&eavesdropper, &event).is_err());
    }

    #[test]
    fn meta_rejects_missing_routing_tags() {
        let owner = Keys::generate();
        // Hand-built frame with no host/frame/req tags.
        let event = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_AGENT_HOST_CONTROL as u16),
            "x".repeat(200),
        )
        .tags([Tag::public_key(owner.public_key())])
        .sign_with_keys(&owner)
        .unwrap();
        assert!(control_frame_meta(&event).is_err());
    }
}
