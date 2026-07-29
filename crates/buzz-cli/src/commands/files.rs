use std::cmp::Reverse;

use crate::client::{normalize_events, BuzzClient};
use crate::error::CliError;

const VALID_FILE_TYPES: &[&str] = &["image", "video", "audio", "doc"];

/// Overfetch bound when a `--type` filter is applied client-side, so a
/// type-sparse channel still fills the requested limit.
const TYPE_FILTER_FETCH_LIMIT: u32 = 200;

pub async fn dispatch(
    cmd: crate::FilesCmd,
    client: &BuzzClient,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    match cmd {
        crate::FilesCmd::List {
            channel,
            file_type,
            limit,
            before,
        } => cmd_files_list(client, &channel, file_type.as_deref(), limit, before, format).await,
    }
}

/// Broad type class of a MIME value, mirroring the desktop's filter chips.
fn mime_class(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else {
        "doc"
    }
}

fn tag_value<'a>(event: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    event.get("tags")?.as_array()?.iter().find_map(|t| {
        let parts = t.as_array()?;
        if parts.first()?.as_str()? == key {
            parts.get(1)?.as_str()
        } else {
            None
        }
    })
}

/// List kind-1063 file-index entries for a channel, newest first.
///
/// The index is relay-derived (one entry per attachment per share); entries
/// carry `url`/`m`/`x`/`size`, optional `filename`/`thumb`, the source
/// message in `e`, the share time in `shared_at`, and the sharer in
/// `uploader`. See docs/channel-files-explorer.md.
async fn cmd_files_list(
    client: &BuzzClient,
    channel: &str,
    file_type: Option<&str>,
    limit: u32,
    before: Option<u64>,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    if let Some(t) = file_type {
        if !VALID_FILE_TYPES.contains(&t) {
            return Err(CliError::Usage(format!(
                "invalid file type {t:?} — must be one of: {}",
                VALID_FILE_TYPES.join(", ")
            )));
        }
    }

    let limit = limit.clamp(1, TYPE_FILTER_FETCH_LIMIT);
    let fetch_limit = if file_type.is_some() {
        TYPE_FILTER_FETCH_LIMIT
    } else {
        limit
    };

    let mut filter = serde_json::json!({
        "kinds": [buzz_core::kind::KIND_FILE_METADATA],
        "#h": [channel],
        "limit": fetch_limit,
    });
    if let Some(ts) = before {
        filter["until"] = serde_json::json!(ts);
    }

    let resp = client.query(&filter).await?;
    let mut events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();

    if let Some(wanted) = file_type {
        events.retain(|e| tag_value(e, "m").map(mime_class) == Some(wanted));
    }
    // Display order is share order: `shared_at` (source message time) with
    // `created_at` (emission time) as the tiebreak/fallback.
    events.sort_by_key(|e| {
        let created = e.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let shared = tag_value(e, "shared_at")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(created);
        Reverse((shared, created))
    });
    events.truncate(limit as usize);

    let normalized = normalize_events(&events);
    let output = match format {
        crate::OutputFormat::Compact => {
            let evts: Vec<serde_json::Value> =
                serde_json::from_str(&normalized).unwrap_or_default();
            let compact: Vec<serde_json::Value> = evts
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "name": e.get("content").cloned().unwrap_or_default(),
                        "url": tag_value(e, "url"),
                        "m": tag_value(e, "m"),
                        "size": tag_value(e, "size"),
                        "shared_at": tag_value(e, "shared_at"),
                        "uploader": tag_value(e, "uploader"),
                        "message": tag_value(e, "e"),
                    })
                })
                .collect();
            serde_json::to_string(&compact).unwrap_or_default()
        }
        crate::OutputFormat::Json => normalized,
    };
    println!("{output}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_class_buckets() {
        assert_eq!(mime_class("image/png"), "image");
        assert_eq!(mime_class("video/mp4"), "video");
        assert_eq!(mime_class("audio/flac"), "audio");
        assert_eq!(mime_class("application/pdf"), "doc");
        assert_eq!(mime_class("text/plain"), "doc");
    }

    #[test]
    fn tag_value_reads_first_match() {
        let event = serde_json::json!({
            "tags": [["m", "image/png"], ["url", "https://r/media/x.png"]]
        });
        assert_eq!(tag_value(&event, "m"), Some("image/png"));
        assert_eq!(tag_value(&event, "url"), Some("https://r/media/x.png"));
        assert_eq!(tag_value(&event, "x"), None);
    }
}
