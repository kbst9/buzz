//! NIP-PC: Agent Provider Credential — payload types, coordinate derivation,
//! and encrypt/decrypt helpers.
//!
//! A `kind:30990` event delivers one AI-provider credential from an agent's
//! owner to the harness process running that agent. Its content is a NIP-44
//! v2 ciphertext (owner key → agent pubkey) that decodes to a
//! [`ProviderCredentialPayload`] JSON object. The event is addressed by
//! `(owner pubkey, kind, "<agent-pubkey-hex>:<provider-id>")` so re-delivery
//! and revocation replace in place under NIP-33 LWW, and carries the
//! recipient agent in its single `p` tag.
//!
//! A `kind:30991` event is the agent-authored, plaintext, non-secret status
//! projection (`d` = provider id) that clients render as credential health.
//!
//! See `docs/nips/NIP-PC.md` for the full specification.

use nostr::{Event, Keys, PublicKey};
use serde::{Deserialize, Serialize};

use crate::observer::{decrypt_observer_payload, encrypt_observer_payload, ObserverPayloadError};

// Re-export for callers that only need the error type.
pub use crate::observer::ObserverPayloadError as ProviderCredentialError;

/// Maximum length of a provider id (`anthropic`, `openai-codex`, `xai`, …).
pub const PROVIDER_ID_MAX_LEN: usize = 32;

/// Returns `true` if `id` matches the provider-id grammar
/// `^[a-z0-9][a-z0-9_-]{0,31}$` (the same slug shape persona `d` tags use).
pub fn is_valid_provider_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > PROVIDER_ID_MAX_LEN {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Returns `true` for a 64-char lowercase-hex string (a Nostr pubkey in hex).
pub fn is_lowercase_hex_pubkey(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Build the NIP-PC `d` tag for a delivery: `"<agent-pubkey-hex>:<provider-id>"`.
///
/// Deterministic per `(agent, provider)` so a rotation or revocation replaces
/// the prior delivery in place at the same NIP-33 coordinate.
pub fn provider_credential_d_tag(agent_pubkey_hex: &str, provider_id: &str) -> String {
    format!("{agent_pubkey_hex}:{provider_id}")
}

/// Parse and validate a NIP-PC `d` tag into `(agent_pubkey_hex, provider_id)`.
///
/// Returns `None` unless the value is exactly `<64-lowercase-hex>:<provider>`
/// with a grammar-valid provider id.
pub fn parse_provider_credential_d_tag(d: &str) -> Option<(&str, &str)> {
    let (agent, provider) = d.split_once(':')?;
    if !is_lowercase_hex_pubkey(agent) || !is_valid_provider_id(provider) {
        return None;
    }
    Some((agent, provider))
}

/// Decrypted payload of a `kind:30990` Agent Provider Credential event.
///
/// `credential` is the pi-style credential object, carried verbatim
/// (`{"type":"api_key","key":…}` or
/// `{"type":"oauth","access":…,"refresh":…,"expires":…, …}`) — the sink
/// merges it into the host credential store without re-shaping, so
/// provider-specific extra fields survive. Exactly one of `credential` /
/// `revoked: true` must be present: a revocation is a delivery whose payload
/// says "remove this provider's entry".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialPayload {
    /// Payload schema version. Currently `1`.
    pub v: u32,

    /// Provider id (`anthropic`, `openai-codex`, `xai`, …). MUST match the
    /// provider component of the event's `d` tag.
    pub provider: String,

    /// The credential object (pi `Credential` shape), absent on revocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<serde_json::Value>,

    /// `true` to remove the provider's entry from the host store.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub revoked: bool,
}

impl ProviderCredentialPayload {
    /// Validate structural constraints (NIP-PC §Payload):
    /// - `v` must be `1`;
    /// - `provider` must match the provider-id grammar;
    /// - exactly one of `credential` / `revoked: true`;
    /// - `credential`, when present, must be a JSON object whose `type` is
    ///   the string `"api_key"` or `"oauth"`.
    pub fn validate(&self) -> Result<(), ObserverPayloadError> {
        if self.v != 1 {
            return Err(ObserverPayloadError::InvalidPayload(format!(
                "unsupported provider-credential payload version {}",
                self.v
            )));
        }
        if !is_valid_provider_id(&self.provider) {
            return Err(ObserverPayloadError::InvalidPayload(format!(
                "invalid provider id {:?}",
                self.provider
            )));
        }
        match (&self.credential, self.revoked) {
            (Some(_), true) => Err(ObserverPayloadError::InvalidPayload(
                "credential and revoked are mutually exclusive".into(),
            )),
            (None, false) => Err(ObserverPayloadError::InvalidPayload(
                "payload must carry either a credential or revoked: true".into(),
            )),
            (None, true) => Ok(()),
            (Some(credential), false) => {
                let Some(obj) = credential.as_object() else {
                    return Err(ObserverPayloadError::InvalidPayload(
                        "credential must be a JSON object".into(),
                    ));
                };
                match obj.get("type").and_then(|t| t.as_str()) {
                    Some("api_key") | Some("oauth") => Ok(()),
                    other => Err(ObserverPayloadError::InvalidPayload(format!(
                        "credential.type must be \"api_key\" or \"oauth\" (got {other:?})"
                    ))),
                }
            }
        }
    }
}

/// Encrypt a [`ProviderCredentialPayload`] into a NIP-44 v2 ciphertext string
/// using the owner's key pair and the agent's public key.
///
/// This is the content field of a `kind:30990` event.
pub fn encrypt_provider_credential(
    owner_keys: &Keys,
    agent_pubkey: &PublicKey,
    payload: &ProviderCredentialPayload,
) -> Result<String, ObserverPayloadError> {
    payload.validate()?;
    encrypt_observer_payload(owner_keys, agent_pubkey, payload)
}

/// Decrypt and deserialize a [`ProviderCredentialPayload`] from a
/// `kind:30990` event. `agent_keys` is the recipient agent's key pair; the
/// conversation key is derived against `event.pubkey` (the owner).
///
/// Fail-closed: an undecryptable or structurally invalid payload is an error,
/// never treated as absence.
pub fn decrypt_provider_credential(
    agent_keys: &Keys,
    event: &Event,
) -> Result<ProviderCredentialPayload, ObserverPayloadError> {
    let payload: ProviderCredentialPayload = decrypt_observer_payload(agent_keys, event)?;
    payload.validate()?;
    Ok(payload)
}

/// State reported by a `kind:30991` status event.
///
/// Consumers MUST treat unrecognized values as [`ProviderCredentialState::Unknown`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCredentialState {
    /// The delivered credential was decrypted and written to the host store.
    Applied,
    /// The provider's entry was removed (revocation applied).
    Removed,
    /// The delivery could not be applied (decrypt/parse/store failure).
    Error,
    /// Unrecognized state from a newer publisher.
    Unknown,
}

impl<'de> Deserialize<'de> for ProviderCredentialState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(match s.as_str() {
            "applied" => ProviderCredentialState::Applied,
            "removed" => ProviderCredentialState::Removed,
            "error" => ProviderCredentialState::Error,
            _ => ProviderCredentialState::Unknown,
        })
    }
}

/// Plaintext content of a `kind:30991` Agent Provider Credential Status event.
///
/// Deliberately non-secret: never put token material, key fragments, or
/// provider account identifiers in `detail`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialStatusPayload {
    /// Payload schema version. Currently `1`.
    pub v: u32,

    /// Provider id — MUST equal the event's `d` tag.
    pub provider: String,

    /// Outcome of applying the most recent delivery.
    pub state: ProviderCredentialState,

    /// Short human-readable detail (error class, never secret material).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,

    /// Unix seconds when the state was recorded.
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Kind, Tag};
    use serde_json::json;

    fn api_key_payload() -> ProviderCredentialPayload {
        ProviderCredentialPayload {
            v: 1,
            provider: "xai".to_string(),
            credential: Some(json!({"type": "api_key", "key": "xai-test-not-a-real-key"})),
            revoked: false,
        }
    }

    fn oauth_payload() -> ProviderCredentialPayload {
        ProviderCredentialPayload {
            v: 1,
            provider: "anthropic".to_string(),
            credential: Some(json!({
                "type": "oauth",
                "access": "at-test",
                "refresh": "rt-test",
                "expires": 1_800_000_000_000_u64,
                "subscriptionType": "max"
            })),
            revoked: false,
        }
    }

    #[test]
    fn provider_id_grammar() {
        for ok in ["anthropic", "openai-codex", "xai", "a", "0z", "a_b-c9"] {
            assert!(is_valid_provider_id(ok), "{ok} should be valid");
        }
        for bad in [
            "",
            "-lead",
            "_lead",
            "UPPER",
            "has space",
            "has:colon",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 33 chars
        ] {
            assert!(!is_valid_provider_id(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn d_tag_round_trip() {
        let agent = "a".repeat(64);
        let d = provider_credential_d_tag(&agent, "openai-codex");
        assert_eq!(d, format!("{agent}:openai-codex"));
        let (parsed_agent, parsed_provider) =
            parse_provider_credential_d_tag(&d).expect("round trip");
        assert_eq!(parsed_agent, agent);
        assert_eq!(parsed_provider, "openai-codex");
    }

    #[test]
    fn d_tag_parse_rejects_malformed() {
        let agent = "a".repeat(64);
        for bad in [
            "no-colon".to_string(),
            format!("{}:xai", "A".repeat(64)), // uppercase hex
            format!("{}:xai", "a".repeat(63)), // short pubkey
            format!("{agent}:"),               // empty provider
            format!("{agent}:UPPER"),          // bad provider
            format!("{agent}:xai:extra"),      // provider fails grammar on ':'
            String::new(),
        ] {
            assert!(
                parse_provider_credential_d_tag(&bad).is_none(),
                "{bad:?} should not parse"
            );
        }
    }

    #[test]
    fn validate_accepts_api_key_and_oauth() {
        api_key_payload().validate().expect("api_key valid");
        oauth_payload().validate().expect("oauth valid");
    }

    #[test]
    fn validate_accepts_revocation() {
        let p = ProviderCredentialPayload {
            v: 1,
            provider: "anthropic".to_string(),
            credential: None,
            revoked: true,
        };
        p.validate().expect("revocation valid");
    }

    #[test]
    fn validate_rejects_structural_errors() {
        // Neither credential nor revoked.
        let neither = ProviderCredentialPayload {
            v: 1,
            provider: "xai".to_string(),
            credential: None,
            revoked: false,
        };
        assert!(neither.validate().is_err());

        // Both credential and revoked.
        let mut both = api_key_payload();
        both.revoked = true;
        assert!(both.validate().is_err());

        // Bad version.
        let mut bad_v = api_key_payload();
        bad_v.v = 2;
        assert!(bad_v.validate().is_err());

        // Bad provider id.
        let mut bad_provider = api_key_payload();
        bad_provider.provider = "Not Valid".into();
        assert!(bad_provider.validate().is_err());

        // Credential not an object.
        let mut non_object = api_key_payload();
        non_object.credential = Some(json!("just-a-string"));
        assert!(non_object.validate().is_err());

        // Unknown credential type.
        let mut bad_type = api_key_payload();
        bad_type.credential = Some(json!({"type": "password", "key": "x"}));
        assert!(bad_type.validate().is_err());
    }

    #[test]
    fn round_trip_encrypt_decrypt() {
        let owner_keys = Keys::generate();
        let agent_keys = Keys::generate();

        let payload = oauth_payload();
        let ciphertext =
            encrypt_provider_credential(&owner_keys, &agent_keys.public_key(), &payload)
                .expect("encrypt");

        let agent_hex = agent_keys.public_key().to_hex();
        let event = EventBuilder::new(
            Kind::Custom(crate::kind::KIND_AGENT_PROVIDER_CREDENTIAL as u16),
            ciphertext,
        )
        .tags([
            Tag::parse(["d", &provider_credential_d_tag(&agent_hex, "anthropic")]).unwrap(),
            Tag::parse(["p", &agent_hex]).unwrap(),
        ])
        .sign_with_keys(&owner_keys)
        .expect("sign");

        let decoded = decrypt_provider_credential(&agent_keys, &event).expect("decrypt");
        assert_eq!(decoded, payload);
        // Provider-specific extra fields must survive verbatim.
        assert_eq!(
            decoded
                .credential
                .as_ref()
                .and_then(|c| c.get("subscriptionType"))
                .and_then(|v| v.as_str()),
            Some("max")
        );
    }

    #[test]
    fn wrong_key_decrypt_fails_closed() {
        let owner_keys = Keys::generate();
        let agent_keys = Keys::generate();
        let wrong_keys = Keys::generate();

        let ciphertext =
            encrypt_provider_credential(&owner_keys, &agent_keys.public_key(), &api_key_payload())
                .expect("encrypt");
        let event = EventBuilder::new(
            Kind::Custom(crate::kind::KIND_AGENT_PROVIDER_CREDENTIAL as u16),
            ciphertext,
        )
        .sign_with_keys(&owner_keys)
        .expect("sign");

        assert!(
            decrypt_provider_credential(&wrong_keys, &event).is_err(),
            "an undecryptable delivery must be an error, not absence"
        );
    }

    #[test]
    fn decrypt_rejects_structurally_invalid_payload() {
        // A payload that decrypts fine but fails validate() (encrypted via the
        // lower-level path, bypassing the validating encrypt helper).
        use crate::observer::encrypt_observer_payload;

        let owner_keys = Keys::generate();
        let agent_keys = Keys::generate();
        let bad = ProviderCredentialPayload {
            v: 1,
            provider: "xai".to_string(),
            credential: None,
            revoked: false,
        };
        let ciphertext = encrypt_observer_payload(&owner_keys, &agent_keys.public_key(), &bad)
            .expect("lower-level encrypt succeeds without validation");
        let event = EventBuilder::new(
            Kind::Custom(crate::kind::KIND_AGENT_PROVIDER_CREDENTIAL as u16),
            ciphertext,
        )
        .sign_with_keys(&owner_keys)
        .expect("sign");

        assert!(
            decrypt_provider_credential(&agent_keys, &event).is_err(),
            "decrypt must re-validate structure symmetrically with encrypt"
        );
    }

    #[test]
    fn status_payload_serde_and_unknown_state() {
        let status = ProviderCredentialStatusPayload {
            v: 1,
            provider: "anthropic".to_string(),
            state: ProviderCredentialState::Applied,
            detail: None,
            updated_at: 1_754_800_000,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"state\":\"applied\""));
        assert!(json.contains("\"updatedAt\":1754800000"));
        let back: ProviderCredentialStatusPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back, status);

        // Forward compatibility: unrecognized state maps to Unknown, not error.
        let future = r#"{"v":1,"provider":"anthropic","state":"quarantined","updatedAt":1}"#;
        let parsed: ProviderCredentialStatusPayload = serde_json::from_str(future).unwrap();
        assert_eq!(parsed.state, ProviderCredentialState::Unknown);
    }
}
