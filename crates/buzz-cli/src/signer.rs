//! Signing backend for the CLI: a local keypair, or a host-side signing
//! broker reached over a Unix socket (`BUZZ_SIGNER_SOCKET`).
//!
//! The broker mode exists so sandboxed agent shells never hold the Nostr
//! private key: the key stays with the host process (the flue-host broker),
//! and the sandboxed `buzz` sends unsigned events over a local socket to be
//! signed. Egress control cannot stop an in-band key leak (an agent tricked
//! into posting `$BUZZ_PRIVATE_KEY` through an allowlisted channel leaks it);
//! removing the key from the environment can.
//!
//! Protocol (one request per connection, newline-delimited JSON):
//!
//! ```text
//! -> {"op":"get_public_key"}
//! <- {"ok":true,"result":"<64-hex pubkey>"}
//! -> {"op":"sign_event","event":{<NIP-01 unsigned event JSON>}}
//! <- {"ok":true,"result":{<full signed event JSON>}}
//! <- {"ok":false,"error":"<detail>"}          (any failure)
//! ```
//!
//! Every signed event returned by the broker is verified (id + signature)
//! before use, so a misbehaving broker surfaces loudly instead of producing
//! events the relay rejects.

use nostr::nips::nip44::v2::ConversationKey;
use nostr::{Event, EventBuilder, JsonUtil, Keys, PublicKey};
use serde::Deserialize;
use std::time::Duration;

use crate::error::CliError;

/// Cap on a single broker response line (a signed event is ~1–64 KB).
const MAX_RESPONSE_BYTES: u64 = 1_048_576;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// The CLI's signing identity: a local keypair or a socket-backed broker.
///
/// Debug prints the variant only — never key material.
pub enum BuzzSigner {
    /// Today's mode: the private key is present in this process.
    Local(Keys),
    /// Broker mode: only the public key is known locally; signing round-trips
    /// over the Unix socket at `path`.
    Socket {
        path: std::path::PathBuf,
        pubkey: PublicKey,
    },
}

impl std::fmt::Debug for BuzzSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(_) => write!(f, "BuzzSigner::Local"),
            Self::Socket { path, .. } => write!(f, "BuzzSigner::Socket({})", path.display()),
        }
    }
}

#[derive(Deserialize)]
struct BrokerResponse {
    ok: bool,
    #[serde(default)]
    result: serde_json::Value,
    #[serde(default)]
    error: Option<String>,
}

impl BuzzSigner {
    /// Build from the resolved CLI config: an explicit private key wins;
    /// otherwise a signer socket; otherwise a clear error naming both.
    pub fn from_config(
        private_key: Option<&str>,
        signer_socket: Option<&str>,
    ) -> Result<Self, CliError> {
        if let Some(pk) = private_key {
            let keys = Keys::parse(pk)
                .map_err(|e| CliError::Key(format!("invalid BUZZ_PRIVATE_KEY: {e}")))?;
            return Ok(Self::Local(keys));
        }
        if let Some(path) = signer_socket {
            let path = std::path::PathBuf::from(path);
            let pubkey = socket_get_public_key(&path)?;
            return Ok(Self::Socket { path, pubkey });
        }
        Err(CliError::Auth(
            "BUZZ_PRIVATE_KEY or BUZZ_SIGNER_SOCKET is required \
             (use --private-key / --signer-socket or set the env var)"
                .into(),
        ))
    }

    /// This identity's public key (known locally in both modes).
    pub fn public_key(&self) -> PublicKey {
        match self {
            Self::Local(keys) => keys.public_key(),
            Self::Socket { pubkey, .. } => *pubkey,
        }
    }

    /// The local keypair, for operations that inherently need the secret
    /// (owner-side: NIP-OA auth-tag minting, agent draft signing). These are
    /// never run by sandboxed fleet agents, so broker mode refuses them.
    pub fn local_keys(&self) -> Result<&Keys, CliError> {
        match self {
            Self::Local(keys) => Ok(keys),
            Self::Socket { .. } => Err(CliError::Auth(
                "this operation requires a local private key and is not \
                 available under the signing broker (BUZZ_SIGNER_SOCKET)"
                    .into(),
            )),
        }
    }

    /// NIP-44 v2 conversation key with `peer` (the agent-memory encryption
    /// lane). Local mode derives it; broker mode requests it — a per-peer
    /// key that cannot sign and cannot recover the master secret, so handing
    /// it to the sandbox only unlocks the one lane the agent already uses.
    pub fn conversation_key(&self, peer: &PublicKey) -> Result<ConversationKey, CliError> {
        match self {
            Self::Local(keys) => ConversationKey::derive(keys.secret_key(), peer)
                .map_err(|e| CliError::Other(format!("conversation key: {e}"))),
            Self::Socket { path, .. } => {
                let result = socket_round_trip(
                    path,
                    &serde_json::json!({"op": "nip44_conversation_key", "peer": peer.to_hex()}),
                )?;
                let hex_str = result.as_str().ok_or_else(|| {
                    CliError::Auth("broker nip44_conversation_key: non-string result".into())
                })?;
                let bytes = hex::decode(hex_str).map_err(|e| {
                    CliError::Auth(format!("broker returned invalid conversation key: {e}"))
                })?;
                ConversationKey::from_slice(&bytes).map_err(|e| {
                    CliError::Auth(format!("broker returned invalid conversation key: {e}"))
                })
            }
        }
    }

    /// Sign a finished builder. The caller has already applied any tag policy
    /// (auth-tag injection and its enforcement live in `BuzzClient`).
    pub fn sign_builder(&self, builder: EventBuilder) -> Result<Event, CliError> {
        match self {
            Self::Local(keys) => builder
                .sign_with_keys(keys)
                .map_err(|e| CliError::Other(format!("signing failed: {e}"))),
            Self::Socket { path, pubkey } => {
                let unsigned = builder.build(*pubkey);
                let request = serde_json::json!({
                    "op": "sign_event",
                    "event": serde_json::from_str::<serde_json::Value>(&unsigned.as_json())
                        .map_err(|e| CliError::Other(format!("unsigned event serialize: {e}")))?,
                });
                let result = socket_round_trip(path, &request)?;
                let event = Event::from_json(result.to_string())
                    .map_err(|e| CliError::Auth(format!("broker returned invalid event: {e}")))?;
                event.verify().map_err(|e| {
                    CliError::Auth(format!("broker signature failed verification: {e}"))
                })?;
                if event.pubkey != *pubkey {
                    return Err(CliError::Auth(
                        "broker signed with an unexpected key".into(),
                    ));
                }
                Ok(event)
            }
        }
    }
}

/// Fetch the broker's public key (used once, at signer construction).
fn socket_get_public_key(path: &std::path::Path) -> Result<PublicKey, CliError> {
    let result = socket_round_trip(path, &serde_json::json!({"op": "get_public_key"}))?;
    let hex = result
        .as_str()
        .ok_or_else(|| CliError::Auth("broker get_public_key: non-string result".into()))?;
    PublicKey::parse(hex)
        .map_err(|e| CliError::Auth(format!("broker returned invalid pubkey: {e}")))
}

/// One request per connection: write a JSON line, read a JSON line.
///
/// Deliberately synchronous (std UDS): broker round-trips are local and
/// sub-millisecond, and a sync signer keeps `BuzzClient::sign_event` and its
/// dozens of callers unchanged. Timeouts make a dead broker fail fast.
#[cfg(unix)]
fn socket_round_trip(
    path: &std::path::Path,
    request: &serde_json::Value,
) -> Result<serde_json::Value, CliError> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect(path).map_err(|e| {
        CliError::Auth(format!(
            "signing broker unreachable at {}: {e}",
            path.display()
        ))
    })?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok();

    let mut writer = stream
        .try_clone()
        .map_err(|e| CliError::Auth(format!("signing broker socket: {e}")))?;
    writer
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|e| CliError::Auth(format!("signing broker write: {e}")))?;

    let mut line = String::new();
    BufReader::new(stream.take(MAX_RESPONSE_BYTES))
        .read_line(&mut line)
        .map_err(|e| CliError::Auth(format!("signing broker read: {e}")))?;
    let response: BrokerResponse = serde_json::from_str(line.trim())
        .map_err(|e| CliError::Auth(format!("signing broker sent invalid JSON: {e}")))?;
    if !response.ok {
        return Err(CliError::Auth(format!(
            "signing broker refused: {}",
            response.error.unwrap_or_else(|| "unknown error".into())
        )));
    }
    Ok(response.result)
}

#[cfg(not(unix))]
fn socket_round_trip(
    _path: &std::path::Path,
    _request: &serde_json::Value,
) -> Result<serde_json::Value, CliError> {
    Err(CliError::Auth(
        "BUZZ_SIGNER_SOCKET is only supported on Unix platforms".into(),
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use nostr::Kind;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    /// Minimal in-test broker: one thread, real Keys, the wire protocol.
    fn spawn_test_broker(dir: &std::path::Path, keys: Keys) -> std::path::PathBuf {
        let path = dir.join("signer.sock");
        let listener = UnixListener::bind(&path).expect("bind test broker");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let request: serde_json::Value = match serde_json::from_str(line.trim()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let response = match request["op"].as_str() {
                    Some("get_public_key") => serde_json::json!({
                        "ok": true,
                        "result": keys.public_key().to_hex(),
                    }),
                    Some("sign_event") => {
                        let unsigned =
                            nostr::UnsignedEvent::from_json(request["event"].to_string())
                                .expect("unsigned event");
                        let signed = unsigned.sign_with_keys(&keys).expect("sign");
                        serde_json::json!({
                            "ok": true,
                            "result": serde_json::from_str::<serde_json::Value>(&signed.as_json()).unwrap(),
                        })
                    }
                    _ => serde_json::json!({"ok": false, "error": "unknown op"}),
                };
                let mut w = stream;
                let _ = w.write_all(format!("{response}\n").as_bytes());
            }
        });
        path
    }

    #[test]
    fn socket_signer_fetches_pubkey_and_signs_verified_events() {
        let dir = tempfile::tempdir().expect("tempdir");
        let keys = Keys::generate();
        let expected_pk = keys.public_key();
        let path = spawn_test_broker(dir.path(), keys);

        let signer =
            BuzzSigner::from_config(None, Some(path.to_str().unwrap())).expect("socket signer");
        assert_eq!(signer.public_key(), expected_pk);

        let event = signer
            .sign_builder(EventBuilder::new(Kind::TextNote, "broker-signed"))
            .expect("sign via broker");
        assert_eq!(event.pubkey, expected_pk);
        assert_eq!(event.content, "broker-signed");
        event.verify().expect("valid id + signature");
    }

    #[test]
    fn local_keys_refused_in_socket_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = spawn_test_broker(dir.path(), Keys::generate());
        let signer =
            BuzzSigner::from_config(None, Some(path.to_str().unwrap())).expect("socket signer");
        let err = signer.local_keys().expect_err("must refuse");
        assert!(err.to_string().contains("signing broker"));
    }

    #[test]
    fn missing_both_key_and_socket_is_a_clear_error() {
        let err = BuzzSigner::from_config(None, None).expect_err("must error");
        assert!(err.to_string().contains("BUZZ_PRIVATE_KEY"));
        assert!(err.to_string().contains("BUZZ_SIGNER_SOCKET"));
    }

    #[test]
    fn dead_socket_fails_fast_with_clear_error() {
        let err = BuzzSigner::from_config(None, Some("/nonexistent/signer.sock"))
            .expect_err("must error");
        assert!(err.to_string().contains("unreachable"));
    }
}
