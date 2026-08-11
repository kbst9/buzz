//! NIP-PC owner side — the desktop AI-accounts pane's Tauri backend.
//!
//! Runs the provider subscription sign-in flows (host-side, secrets never
//! reach the renderer), stores the resulting credential in the OS keychain,
//! and builds owner-signed `kind:30990` delivery events for the agents this
//! owner runs. The renderer only ever sees non-secret [`AiAccountSummary`]
//! rows and publishes the pre-signed events over its existing relay socket.
//!
//! Credential shape is the pi-ai `Credential` object, carried verbatim so the
//! host's flue-host store (and pi's own provider `toAuth`) consume it
//! unchanged:
//! - `{"type":"api_key","key":"…"}`
//! - `{"type":"oauth","access":"…","refresh":"…","expires":<unix-ms>}`
//!
//! Flows ported faithfully from `@earendil-works/pi-ai`'s `auth/oauth/*`
//! (same public client ids, endpoints, PKCE, request bodies): Anthropic is a
//! PKCE authorization-code flow with a loopback callback; xAI is an OAuth
//! device-code flow. OpenAI Codex and Cursor are surfaced in the UI but not
//! yet wired here (see [`provider_flow`]).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State as AxumState},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use base64::Engine as _;
use nostr::{Keys, PublicKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::app_state::AppState;
use crate::app_state_keyring::keyring_service;
use crate::secret_store::SecretStore;

/// Keychain key prefix; one blob per provider alongside the identity nsec.
const STORE_PREFIX: &str = "ai-account.";
/// Overall wall-clock budget for an interactive login.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Which sign-in mechanism a provider uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderFlow {
    /// PKCE authorization-code with a loopback redirect (Anthropic).
    PkceLoopback,
    /// OAuth 2.0 device-code (xAI).
    DeviceCode,
    /// Recognized but not yet implemented in this backend.
    Unsupported,
}

/// Static per-provider flow selection. Adding OpenAI Codex later is a new arm
/// here plus its flow function — not a change to the command surface.
fn provider_flow(provider: &str) -> ProviderFlow {
    match provider {
        "anthropic" => ProviderFlow::PkceLoopback,
        "xai" => ProviderFlow::DeviceCode,
        // Device flow is a two-stage device→PKCE exchange; scaffolded as a
        // follow-up so a half-tested flow does not ship.
        "openai-codex" => ProviderFlow::Unsupported,
        _ => ProviderFlow::Unsupported,
    }
}

/// Non-secret account row for the settings pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccountSummary {
    /// Provider id (`anthropic`, `xai`, …).
    pub provider: String,
    /// Credential type: `oauth` or `api_key`.
    pub kind: String,
    /// Unix seconds the credential was stored/rotated locally.
    pub connected_at: u64,
}

/// The keychain blob for one provider: the raw pi credential plus local
/// metadata. Secret — never returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
    credential: serde_json::Value,
    connected_at: u64,
}

impl StoredAccount {
    fn summary(&self, provider: &str) -> AiAccountSummary {
        let kind = self
            .credential
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("unknown")
            .to_string();
        AiAccountSummary {
            provider: provider.to_string(),
            kind,
            connected_at: self.connected_at,
        }
    }
}

fn store() -> &'static SecretStore {
    SecretStore::shared(keyring_service())
}

fn store_key(provider: &str) -> String {
    format!("{STORE_PREFIX}{provider}")
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_account(provider: &str) -> Result<Option<StoredAccount>, String> {
    match store().load(&store_key(provider))? {
        Some(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("corrupt stored account for {provider}: {e}")),
        None => Ok(None),
    }
}

fn write_account(provider: &str, credential: serde_json::Value) -> Result<StoredAccount, String> {
    let account = StoredAccount {
        credential,
        connected_at: unix_now(),
    };
    let json = serde_json::to_string(&account).map_err(|e| format!("serialize account: {e}"))?;
    store().store(&store_key(provider), &json)?;
    Ok(account)
}

// ── Tauri commands ───────────────────────────────────────────────────────

/// List the owner's stored provider accounts (non-secret summaries).
#[tauri::command]
pub fn list_ai_accounts() -> Result<Vec<AiAccountSummary>, String> {
    let Some(all) = store().load_all_readonly()? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (key, value) in all {
        let Some(provider) = key.strip_prefix(STORE_PREFIX) else {
            continue;
        };
        match serde_json::from_str::<StoredAccount>(&value) {
            Ok(account) => out.push(account.summary(provider)),
            Err(e) => {
                tracing::warn!(provider, "skipping corrupt ai-account blob: {e}");
            }
        }
    }
    out.sort_by(|a, b| a.provider.cmp(&b.provider));
    Ok(out)
}

/// Remove a stored provider account. Revocation delivery to agents is a
/// separate step (`build_ai_account_delivery_events` with `revoke = true`).
#[tauri::command]
pub fn remove_ai_account(provider: String) -> Result<(), String> {
    store().delete(&store_key(&provider))
}

/// Run a provider subscription sign-in, store the credential, and return the
/// non-secret summary. Emits `ai-account-oauth-prompt` events (browser URL /
/// device code) that the renderer's progress dialog listens for.
#[tauri::command]
pub async fn ai_account_oauth_login(
    app: AppHandle,
    provider: String,
) -> Result<AiAccountSummary, String> {
    let credential = match provider_flow(&provider) {
        ProviderFlow::PkceLoopback => anthropic_login(&app, &provider).await?,
        ProviderFlow::DeviceCode => xai_device_login(&app, &provider).await?,
        ProviderFlow::Unsupported => {
            return Err(format!(
                "sign-in for {provider} is not available yet in this build"
            ));
        }
    };
    // Persist off the async runtime — keychain writes are blocking IO.
    let provider_for_store = provider.clone();
    let account = tauri::async_runtime::spawn_blocking(move || {
        write_account(&provider_for_store, credential)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;
    Ok(account.summary(&provider))
}

/// Build owner-signed `kind:30990` delivery events, one per agent pubkey, for
/// the stored provider credential. With `revoke = true`, delivers a revocation
/// payload instead (and the caller has typically already removed the local
/// blob). Returns event JSON strings for the renderer to publish over its
/// relay socket. Mirrors `build_observer_control_event`.
#[tauri::command]
pub fn build_ai_account_delivery_events(
    provider: String,
    agent_pubkeys: Vec<String>,
    revoke: bool,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let keys: Keys = state.signing_keys()?;

    let payload_credential = if revoke {
        None
    } else {
        let account = read_account(&provider)?
            .ok_or_else(|| format!("no stored credential for {provider}"))?;
        Some(account.credential)
    };

    let mut events = Vec::with_capacity(agent_pubkeys.len());
    for agent_hex in &agent_pubkeys {
        let agent_pubkey = PublicKey::from_hex(agent_hex.trim())
            .map_err(|e| format!("invalid agent pubkey {agent_hex}: {e}"))?;
        let agent_hex = agent_pubkey.to_hex();

        let payload = buzz_core_pkg::provider_credential::ProviderCredentialPayload {
            v: 1,
            provider: provider.clone(),
            credential: payload_credential.clone(),
            revoked: revoke,
        };
        let ciphertext = buzz_core_pkg::provider_credential::encrypt_provider_credential(
            &keys,
            &agent_pubkey,
            &payload,
        )
        .map_err(|e| format!("encrypt provider credential: {e}"))?;

        let event =
            buzz_sdk_pkg::build_agent_provider_credential(&agent_hex, &provider, &ciphertext)
                .map_err(|e| format!("build provider credential event: {e}"))?
                .sign_with_keys(&keys)
                .map_err(|e| format!("sign provider credential event: {e}"))?;
        events.push(event.as_json());
    }
    Ok(events)
}

// ── OAuth: Anthropic (PKCE + loopback) ───────────────────────────────────

const ANTHROPIC_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/// Fixed loopback port — the redirect_uri is registered with the provider.
const ANTHROPIC_CALLBACK_PORT: u16 = 53692;

/// Public Claude Code client id (base64 in pi to keep it out of plain grep;
/// it is a public identifier, not a secret).
fn anthropic_client_id() -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl")
        .unwrap_or_default();
    String::from_utf8(bytes).unwrap_or_default()
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE verifier (32 random bytes, base64url) + S256 challenge.
fn generate_pkce() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    getrandom::getrandom(&mut verifier_bytes).ok();
    let verifier = base64url(&verifier_bytes);
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

#[derive(Clone)]
struct CallbackState {
    sender: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<(String, String), String>>>>>,
}

async fn callback_handler(
    Query(params): Query<HashMap<String, String>>,
    AxumState(state): AxumState<CallbackState>,
) -> Response {
    let result = match params.get("code").filter(|c| !c.is_empty()) {
        Some(code) => Ok((
            code.clone(),
            params.get("state").cloned().unwrap_or_default(),
        )),
        None => Err(params
            .get("error_description")
            .or_else(|| params.get("error"))
            .cloned()
            .unwrap_or_else(|| "authorization callback did not include a code".to_string())),
    };
    if let Ok(mut guard) = state.sender.lock() {
        if let Some(sender) = guard.take() {
            let _ = sender.send(result);
        }
    }
    Html(OAUTH_COMPLETE_HTML).into_response()
}

async fn anthropic_login(app: &AppHandle, provider: &str) -> Result<serde_json::Value, String> {
    let (verifier, challenge) = generate_pkce();
    let client_id = anthropic_client_id();
    let redirect_uri = format!("http://localhost:{ANTHROPIC_CALLBACK_PORT}/callback");

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", ANTHROPIC_CALLBACK_PORT))
        .await
        .map_err(|e| {
            format!(
                "could not start the sign-in callback on port {ANTHROPIC_CALLBACK_PORT} \
                 (another sign-in may be in progress): {e}"
            )
        })?;

    let (tx, rx) = oneshot::channel();
    let callback_state = CallbackState {
        sender: Arc::new(std::sync::Mutex::new(Some(tx))),
    };
    let router = Router::new()
        .route("/callback", get(callback_handler))
        .with_state(callback_state);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let authorize_url = {
        let mut url = url::Url::parse(ANTHROPIC_AUTHORIZE_URL)
            .map_err(|e| format!("build authorize url: {e}"))?;
        url.query_pairs_mut()
            .append_pair("code", "true")
            .append_pair("client_id", client_id.as_str())
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", redirect_uri.as_str())
            .append_pair("scope", ANTHROPIC_SCOPES)
            .append_pair("code_challenge", challenge.as_str())
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", verifier.as_str());
        url.to_string()
    };

    let _ = app.emit(
        "ai-account-oauth-prompt",
        json!({
            "provider": provider,
            "kind": "auth_url",
            "url": authorize_url,
            "message": "Complete sign-in in your browser to connect your Claude subscription.",
        }),
    );
    if let Err(e) = app.opener().open_url(authorize_url.as_str(), None::<&str>) {
        server.abort();
        return Err(format!("could not open the browser for sign-in: {e}"));
    }

    let outcome = tokio::time::timeout(LOGIN_TIMEOUT, rx).await;
    server.abort();
    let (code, state) = match outcome {
        Ok(Ok(Ok(pair))) => pair,
        Ok(Ok(Err(e))) => return Err(e),
        Ok(Err(_)) => return Err("sign-in callback stopped unexpectedly".to_string()),
        Err(_) => return Err("sign-in timed out".to_string()),
    };
    if state != verifier {
        return Err("sign-in state mismatch — please try again".to_string());
    }

    let body = json!({
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "state": state,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    });
    let resp = reqwest::Client::new()
        .post(ANTHROPIC_TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("token exchange request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange failed ({status}): {text}"));
    }
    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token exchange returned invalid JSON: {e}"))?;
    Ok(token.into_oauth_credential())
}

// ── OAuth: xAI (device code) ─────────────────────────────────────────────

const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

impl TokenResponse {
    /// Map to the pi `oauth` credential shape. `expires` is Unix **ms** minus a
    /// 5-minute refresh skew, matching pi so the host refreshes on time.
    fn into_oauth_credential(self) -> serde_json::Value {
        let lifetime = self.expires_in.unwrap_or(3600);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let expires = now_ms + lifetime * 1000 - 5 * 60 * 1000;
        json!({
            "type": "oauth",
            "access": self.access_token,
            "refresh": self.refresh_token.unwrap_or_default(),
            "expires": expires,
        })
    }
}

async fn xai_device_login(app: &AppHandle, provider: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let device: DeviceCodeResponse = {
        let resp = client
            .post(XAI_DEVICE_CODE_URL)
            .form(&[
                ("client_id", XAI_CLIENT_ID),
                ("scope", XAI_SCOPE),
                ("referrer", "buzz"),
            ])
            .send()
            .await
            .map_err(|e| format!("device authorization request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("device authorization failed ({status}): {text}"));
        }
        resp.json()
            .await
            .map_err(|e| format!("device authorization returned invalid JSON: {e}"))?
    };

    let verification = device
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| device.verification_uri.clone());
    let _ = app.emit(
        "ai-account-oauth-prompt",
        json!({
            "provider": provider,
            "kind": "device_code",
            "userCode": device.user_code,
            "verificationUri": verification,
            "message": "Enter the code shown to connect your xAI subscription.",
        }),
    );
    let _ = app.opener().open_url(verification.as_str(), None::<&str>);

    let interval = Duration::from_secs(device.interval.unwrap_or(5).max(1));
    let deadline = tokio::time::Instant::now()
        + Duration::from_secs(device.expires_in.unwrap_or(600)).min(LOGIN_TIMEOUT);
    let mut poll_interval = interval;

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("sign-in timed out".to_string());
        }
        tokio::time::sleep(poll_interval).await;

        let resp = client
            .post(XAI_TOKEN_URL)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", XAI_CLIENT_ID),
                ("device_code", device.device_code.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("device token poll failed: {e}"))?;
        if resp.status().is_success() {
            let token: TokenResponse = resp
                .json()
                .await
                .map_err(|e| format!("device token returned invalid JSON: {e}"))?;
            return Ok(token.into_oauth_credential());
        }
        let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| json!({}));
        match body.get("error").and_then(|e| e.as_str()) {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                poll_interval += Duration::from_secs(5);
            }
            Some("access_denied") | Some("authorization_denied") => {
                return Err("sign-in was denied".to_string());
            }
            Some("expired_token") => return Err("sign-in code expired".to_string()),
            other => {
                return Err(format!(
                    "device authorization failed: {}",
                    other.unwrap_or("unknown error")
                ));
            }
        }
    }
}

const OAUTH_COMPLETE_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>Buzz — sign-in complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e7e7ea;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{text-align:center;padding:2rem}</style></head>
<body><div class="card"><h1>Signed in</h1>
<p>You can close this tab and return to Buzz.</p></div></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (verifier, challenge) = generate_pkce();
        // Verifier is 32 bytes base64url (43 chars, no padding).
        assert_eq!(verifier.len(), 43);
        let expected = base64url(&Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
        // Two calls differ (random verifier).
        let (v2, _) = generate_pkce();
        assert_ne!(verifier, v2);
    }

    #[test]
    fn anthropic_client_id_decodes() {
        let id = anthropic_client_id();
        assert_eq!(id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    }

    #[test]
    fn provider_flow_selection() {
        assert_eq!(provider_flow("anthropic"), ProviderFlow::PkceLoopback);
        assert_eq!(provider_flow("xai"), ProviderFlow::DeviceCode);
        assert_eq!(provider_flow("openai-codex"), ProviderFlow::Unsupported);
        assert_eq!(provider_flow("cursor"), ProviderFlow::Unsupported);
    }

    #[test]
    fn token_response_maps_to_oauth_credential() {
        let token = TokenResponse {
            access_token: "at".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_in: Some(3600),
        };
        let cred = token.into_oauth_credential();
        assert_eq!(cred["type"], "oauth");
        assert_eq!(cred["access"], "at");
        assert_eq!(cred["refresh"], "rt");
        // expires is unix-ms in the future minus the 5-min skew.
        let expires = cred["expires"].as_u64().unwrap();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(expires > now_ms);
        assert!(expires < now_ms + 3600 * 1000);
    }

    #[test]
    fn stored_account_summary_hides_secret() {
        let account = StoredAccount {
            credential: json!({"type":"oauth","access":"secret","refresh":"secret"}),
            connected_at: 1_754_800_000,
        };
        let summary = account.summary("anthropic");
        assert_eq!(summary.provider, "anthropic");
        assert_eq!(summary.kind, "oauth");
        assert_eq!(summary.connected_at, 1_754_800_000);
        // The summary serializes without any secret material.
        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("secret"));
    }
}
