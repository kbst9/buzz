//! Community-level commands: the community guide (kind:30979).
//!
//! The guide is owner/admin-authored orientation injected into every agent's
//! system prompt at session creation (see `buzz-acp`'s community fetch).
//! `get` prints the newest head; `set` publishes a replacement — the relay
//! enforces the owner/admin role and the fixed `d` tag `"guide"`.

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::read_or_stdin;

/// Print the community guide's newest head, or `null` when none is set.
pub async fn cmd_get_guide(client: &BuzzClient) -> Result<(), CliError> {
    let filter = serde_json::json!({
        "kinds": [30979],
        "#d": ["guide"],
        "limit": 8
    });
    let resp = client.query(&filter).await?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
    // One head per author (NIP-33): with several owner/admin authors the
    // newest head wins, matching the harness fetch semantics.
    let newest = events.iter().max_by_key(|e| {
        (
            e.get("created_at").and_then(|c| c.as_u64()).unwrap_or(0),
            e.get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string(),
        )
    });
    match newest
        .and_then(|e| e.get("content"))
        .and_then(|c| c.as_str())
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        Some(content) => println!("{content}"),
        None => println!("null"),
    }
    Ok(())
}

/// Publish (replace) the community guide. Empty content clears it.
pub async fn cmd_set_guide(client: &BuzzClient, content: &str) -> Result<(), CliError> {
    let content = read_or_stdin(content)?;

    let builder = buzz_sdk::build_set_community_guide(&content)
        .map_err(|e| CliError::Other(format!("build_set_community_guide failed: {e}")))?;

    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{}", normalize_write_response(&resp));
    Ok(())
}

pub async fn dispatch(cmd: crate::CommunityCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::{CommunityCmd, GuideCmd};
    match cmd {
        CommunityCmd::Guide(guide) => match guide {
            GuideCmd::Get => cmd_get_guide(client).await,
            GuideCmd::Set { content } => cmd_set_guide(client, &content).await,
        },
    }
}
