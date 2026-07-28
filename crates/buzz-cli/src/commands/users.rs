use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::validate_hex64;

// TODO(phase-4): Replace raw nostr::EventBuilder usage in cmd_set_presence with buzz-sdk builder

/// Get user profiles (kind:0 metadata events).
///
/// - 0 pubkeys, no name → query our own profile
/// - 1+ pubkeys → query those users' profiles
/// - --name "foo" → NIP-50 search on kind:0, then client-side filter
pub async fn cmd_get_users(
    client: &BuzzClient,
    pubkeys: &[String],
    name: Option<&str>,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    if let Some(query) = name {
        if !pubkeys.is_empty() {
            return Err(CliError::Usage(
                "--name and --pubkey are mutually exclusive".into(),
            ));
        }
        return search_by_name(client, query, format).await;
    }

    for pk in pubkeys {
        validate_hex64(pk)?;
    }
    if pubkeys.len() > 200 {
        return Err(CliError::Usage("--pubkey: maximum 200 pubkeys".into()));
    }

    let my_pk = client.keys().public_key().to_hex();
    let authors: Vec<&str> = if pubkeys.is_empty() {
        vec![my_pk.as_str()]
    } else {
        pubkeys.iter().map(|s| s.as_str()).collect()
    };

    let filter = serde_json::json!({
        "kinds": [0],
        "authors": authors,
        "limit": authors.len()
    });
    let resp = client.query(&filter).await?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    let profiles: Vec<serde_json::Value> = events
        .iter()
        .filter_map(|e| {
            let content_str = e.get("content")?.as_str()?;
            let mut profile: serde_json::Value = serde_json::from_str(content_str).ok()?;
            if let Some(obj) = profile.as_object_mut() {
                obj.insert(
                    "pubkey".to_string(),
                    serde_json::json!(e.get("pubkey").and_then(|v| v.as_str()).unwrap_or("")),
                );
            }
            Some(profile)
        })
        .collect();
    let output = match format {
        crate::OutputFormat::Compact => {
            let compact: Vec<serde_json::Value> = profiles
                .iter()
                .map(|p| serde_json::json!({
                    "pubkey": p.get("pubkey").cloned().unwrap_or_default(),
                    "display_name": p.get("display_name").or_else(|| p.get("name")).cloned().unwrap_or_default(),
                }))
                .collect();
            serde_json::to_string(&compact).unwrap_or_default()
        }
        crate::OutputFormat::Json => serde_json::to_string(&profiles).unwrap_or_default(),
    };
    println!("{output}");
    Ok(())
}

/// Search for users by display name via NIP-50 full-text search on kind:0 profiles.
/// Returns [] if the relay does not implement NIP-50 search.
async fn search_by_name(
    client: &BuzzClient,
    query: &str,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    if query.trim().is_empty() {
        return Err(CliError::Usage("--name cannot be empty".into()));
    }

    let filter = serde_json::json!({
        "kinds": [0],
        "search": query,
        "limit": 100
    });
    let raw = client.query(&filter).await?;

    // Parse and filter client-side for case-insensitive substring match
    // on display_name or name fields (NIP-50 may return broader matches).
    let events: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse response: {e}")))?;

    let Some(arr) = events.as_array() else {
        println!("[]");
        return Ok(());
    };

    let lower_query = query.to_ascii_lowercase();
    let profiles: Vec<serde_json::Value> = arr
        .iter()
        .filter_map(|event| {
            let content_str = event.get("content").and_then(|v| v.as_str())?;
            let content: serde_json::Value = serde_json::from_str(content_str).ok()?;
            let display_name = content
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let name = content.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if !display_name.to_ascii_lowercase().contains(&lower_query)
                && !name.to_ascii_lowercase().contains(&lower_query)
            {
                return None;
            }
            let mut profile = content;
            if let Some(obj) = profile.as_object_mut() {
                obj.insert(
                    "pubkey".to_string(),
                    serde_json::json!(event.get("pubkey").and_then(|v| v.as_str()).unwrap_or("")),
                );
            }
            Some(profile)
        })
        .collect();
    let output = match format {
        crate::OutputFormat::Compact => {
            let compact: Vec<serde_json::Value> = profiles
                .iter()
                .map(|p| serde_json::json!({
                    "pubkey": p.get("pubkey").cloned().unwrap_or_default(),
                    "display_name": p.get("display_name").or_else(|| p.get("name")).cloned().unwrap_or_default(),
                }))
                .collect();
            serde_json::to_string(&compact).unwrap_or_default()
        }
        crate::OutputFormat::Json => serde_json::to_string(&profiles).unwrap_or_default(),
    };
    println!("{output}");
    Ok(())
}

pub async fn cmd_set_profile(
    client: &BuzzClient,
    display_name: Option<&str>,
    avatar_url: Option<&str>,
    about: Option<&str>,
    nip05_handle: Option<&str>,
    force: bool,
) -> Result<(), CliError> {
    let overlay = buzz_sdk::profile::ProfileOverlay {
        name: display_name.map(str::to_string),
        avatar_url: avatar_url.map(str::to_string),
        about: about.map(str::to_string),
        nip05: nip05_handle.map(str::to_string),
    };
    if overlay.is_empty() && !force {
        return Err(CliError::Usage(
            "at least one field required (--name, --avatar, --about, --nip05); \
             or pass --force for a normalize-only publish"
                .into(),
        ));
    }

    // Read-merge-write through the sdk helper: unknown content fields and
    // all tags survive. An identity with a NIP-OA auth tag (on the current
    // profile, or supplied via BUZZ_AUTH_TAG — the harness-injected env) is
    // an agent: its merge additionally guarantees the tag is carried
    // forward and the profile is branded bot:true. Rebuilding kind:0 from
    // known fields is exactly how agents got orphaned before — never
    // reintroduce a from-scratch profile write here.
    let me = client.keys().public_key();
    let current = fetch_current_profile_parts(client, &me.to_hex()).await?;
    let env_auth_tag = std::env::var("BUZZ_AUTH_TAG").ok();
    let is_agent_identity = env_auth_tag
        .as_deref()
        .is_some_and(|tag| !tag.trim().is_empty())
        || current
            .as_ref()
            .is_some_and(|profile| buzz_sdk::profile::valid_auth_tag(&me, profile).is_some());

    let merged = if is_agent_identity {
        buzz_sdk::profile::merge_agent_profile(
            &me,
            current.as_ref(),
            &overlay,
            env_auth_tag.as_deref(),
        )
    } else {
        buzz_sdk::profile::merge_profile(current.as_ref(), &overlay)
    }
    .map_err(crate::validate::sdk_err)?;

    if !merged.changed && !force {
        println!(
            "{}",
            serde_json::json!({
                "accepted": true,
                "message": "profile unchanged — nothing published"
            })
        );
        return Ok(());
    }

    let builder = merged.into_builder().map_err(crate::validate::sdk_err)?;
    let event = client.sign_event(builder)?;

    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

/// Print the raw kind:0 event (content and tags) for `pubkey`, or the
/// current identity when omitted. Unlike `users get`, nothing is projected
/// away — this is how an operator checks the NIP-OA auth tag survived.
pub async fn cmd_get_profile(client: &BuzzClient, pubkey: Option<&str>) -> Result<(), CliError> {
    let target = match pubkey {
        Some(pk) => {
            validate_hex64(pk)?;
            pk.to_string()
        }
        None => client.keys().public_key().to_hex(),
    };
    let filter = serde_json::json!({
        "kinds": [0],
        "authors": [target],
        "limit": 1
    });
    let raw = client.query(&filter).await?;
    println!("{raw}");
    Ok(())
}

/// Fetch the current kind:0 for `author` as merge input (content + tags).
/// Returns `None` when no profile exists yet.
async fn fetch_current_profile_parts(
    client: &BuzzClient,
    author: &str,
) -> Result<Option<buzz_sdk::profile::CurrentProfile>, CliError> {
    let filter = serde_json::json!({
        "kinds": [0],
        "authors": [author],
        "limit": 1
    });
    let raw = client.query(&filter).await?;
    let events: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CliError::Other(format!("failed to parse profile query: {e}")))?;

    let Some(event) = events.as_array().and_then(|arr| arr.first()) else {
        return Ok(None);
    };
    let content = event
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("{}")
        .to_string();
    let tags: Vec<Vec<String>> = event
        .get("tags")
        .and_then(|t| serde_json::from_value(t.clone()).ok())
        .unwrap_or_default();
    Ok(Some(buzz_sdk::profile::CurrentProfile { content, tags }))
}

/// Get presence status for users — query kind:40902 presence snapshot events.
pub async fn cmd_get_presence(client: &BuzzClient, pubkeys_csv: &str) -> Result<(), CliError> {
    let pubkeys: Vec<&str> = pubkeys_csv
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    for pk in &pubkeys {
        validate_hex64(pk)?;
    }

    let filter = serde_json::json!({
        "kinds": [40902],
        "authors": pubkeys,
        "limit": pubkeys.len()
    });
    let resp = client.query(&filter).await?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    let presence: Vec<serde_json::Value> = events
        .iter()
        .map(|e| {
            serde_json::json!({
                "pubkey": presence_subject(e),
                "status": e.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                "updated_at": e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0),
            })
        })
        .collect();
    let output = serde_json::to_string(&presence).unwrap_or_default();
    println!("{output}");
    Ok(())
}

fn presence_subject(event: &serde_json::Value) -> &str {
    event
        .get("tags")
        .and_then(|tags| tags.as_array())
        .and_then(|tags| {
            tags.iter()
                .find_map(|tag| match tag.as_array()?.as_slice() {
                    [name, subject, ..] if name == "p" => subject.as_str(),
                    _ => None,
                })
        })
        .unwrap_or_else(|| event.get("pubkey").and_then(|v| v.as_str()).unwrap_or(""))
}

/// Set presence status — sign and submit a kind:20001 presence update event via WebSocket.
///
/// Kind 20001 is ephemeral and only accepted via WebSocket connections. This
/// method connects to the relay over WS, performs NIP-42 authentication, and
/// publishes the event directly — bypassing the HTTP bridge.
pub async fn cmd_set_presence(client: &BuzzClient, status: &str) -> Result<(), CliError> {
    let builder = buzz_sdk::build_presence_update(status).map_err(crate::validate::sdk_err)?;
    let event = client.sign_event(builder)?;

    let resp = client.publish_ephemeral_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

pub async fn dispatch(
    cmd: crate::UsersCmd,
    client: &BuzzClient,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    use crate::UsersCmd;
    match cmd {
        UsersCmd::Get { pubkeys, name } => {
            cmd_get_users(client, &pubkeys, name.as_deref(), format).await
        }
        UsersCmd::SetProfile {
            name,
            avatar,
            about,
            nip05,
            force,
        } => {
            cmd_set_profile(
                client,
                name.as_deref(),
                avatar.as_deref(),
                about.as_deref(),
                nip05.as_deref(),
                force,
            )
            .await
        }
        UsersCmd::GetProfile { pubkey } => cmd_get_profile(client, pubkey.as_deref()).await,
        UsersCmd::Presence { pubkeys } => cmd_get_presence(client, &pubkeys).await,
        UsersCmd::SetPresence { status } => cmd_set_presence(client, &status.to_string()).await,
    }
}

#[cfg(test)]
mod tests {
    use super::presence_subject;
    use serde_json::json;

    #[test]
    fn presence_subject_uses_p_tag() {
        let event = json!({"pubkey": "relay", "tags": [["p", "user"]]});
        assert_eq!(presence_subject(&event), "user");
    }

    #[test]
    fn presence_subject_falls_back_to_author_without_p_tag() {
        let event = json!({"pubkey": "user", "tags": [["status", "online"]]});
        assert_eq!(presence_subject(&event), "user");
    }

    #[test]
    fn presence_subject_falls_back_to_author_for_malformed_p_tag() {
        let event = json!({"pubkey": "user", "tags": [["p"]]});
        assert_eq!(presence_subject(&event), "user");
    }
}
