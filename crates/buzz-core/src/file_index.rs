//! NIP-94 file-index derivation from NIP-92 `imeta`-carrying channel events.
//!
//! The relay materializes a per-channel file index as relay-signed kind
//! `1063` ([`crate::kind::KIND_FILE_METADATA`]) events, one per attachment
//! per share. This module holds the pure derivation shared by the live
//! emitter (`buzz-relay` `handlers::file_index`) and `buzz-admin files
//! backfill`, so every producer emits identical event shapes.
//!
//! Index events deliberately carry the source timestamp in a `shared_at`
//! tag rather than `created_at` (replica-fence safety) and the uploader in
//! an `uploader` tag rather than `p` (no mention/push semantics). Design and
//! events-table trigger analysis: `docs/channel-files-explorer.md`.

use std::collections::HashSet;

use nostr::{Event, Tag};

/// Defensive cap on accepted imeta value lengths. Ingest validation is
/// stricter for message kinds, but derivation may encounter other kinds
/// whose tags never passed `validate_imeta_tags`.
const MAX_VALUE_LEN: usize = 2048;

/// One well-formed NIP-92 `imeta` attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImetaEntry {
    /// Blob URL (`/media/<sha256>.<ext>` on the relay).
    pub url: String,
    /// MIME type (`m`).
    pub mime: String,
    /// SHA-256 blob hash (`x`), 64 lowercase hex chars.
    pub sha256: String,
    /// Size in bytes (`size`), decimal string.
    pub size: String,
    /// Pixel dimensions (`dim`), when present.
    pub dim: Option<String>,
    /// Blurhash, when present.
    pub blurhash: Option<String>,
    /// Thumbnail URL (`thumb`), when present.
    pub thumb: Option<String>,
    /// Media duration in seconds (`duration`), when present.
    pub duration: Option<String>,
    /// Original filename (`filename`), when present.
    pub filename: Option<String>,
    /// Alt text (`alt`), when present.
    pub alt: Option<String>,
}

fn is_hex_hash(v: &str) -> bool {
    v.len() == 64 && v.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Parse the well-formed `imeta` attachments on `event`.
///
/// Strict per entry: an imeta tag missing any of `url`/`m`/`x`/`size`, or
/// carrying a malformed hash, non-numeric size, non-http(s) URL, or an
/// oversized value, is skipped rather than indexed.
pub fn parse_imeta_entries(event: &Event) -> Vec<ImetaEntry> {
    let mut out = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some("imeta") {
            continue;
        }

        let mut url = None;
        let mut mime = None;
        let mut sha256 = None;
        let mut size = None;
        let mut dim = None;
        let mut blurhash = None;
        let mut thumb = None;
        let mut duration = None;
        let mut filename = None;
        let mut alt = None;

        for part in parts.iter().skip(1) {
            let mut kv = part.splitn(2, ' ');
            let key = kv.next().unwrap_or("");
            let value = kv.next().unwrap_or("");
            if value.is_empty() || value.len() > MAX_VALUE_LEN {
                continue;
            }
            match key {
                "url" => url = Some(value.to_string()),
                "m" => mime = Some(value.to_string()),
                "x" => sha256 = Some(value.to_string()),
                "size" => size = Some(value.to_string()),
                "dim" => dim = Some(value.to_string()),
                "blurhash" => blurhash = Some(value.to_string()),
                "thumb" => thumb = Some(value.to_string()),
                "duration" => duration = Some(value.to_string()),
                "filename" => filename = Some(value.to_string()),
                "alt" => alt = Some(value.to_string()),
                _ => {}
            }
        }

        let (Some(url), Some(mime), Some(sha256), Some(size)) = (url, mime, sha256, size) else {
            continue;
        };
        if !url.starts_with("http://") && !url.starts_with("https://") {
            continue;
        }
        if !is_hex_hash(&sha256) || size.parse::<u64>().is_err() {
            continue;
        }

        out.push(ImetaEntry {
            url,
            mime,
            sha256,
            size,
            dim,
            blurhash,
            thumb,
            duration,
            filename,
            alt,
        });
    }
    out
}

/// First well-formed `e` tag value — the kind-40003 edit-target convention
/// (shared with the relay's `validate_edit_ownership`).
pub fn first_e_tag_hex(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        let parts = t.as_slice();
        if parts.first().map(String::as_str) != Some("e") {
            return None;
        }
        parts
            .get(1)
            .filter(|v| v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|v| v.to_string())
    })
}

/// The `x` tag value of a stored kind-1063 index entry.
pub fn x_tag_value(event: &Event) -> Option<String> {
    event.tags.iter().find_map(|t| {
        let parts = t.as_slice();
        (parts.first().map(String::as_str) == Some("x"))
            .then(|| parts.get(1).map(|v| v.to_string()))
            .flatten()
    })
}

/// The blob hashes (`x` values) of an event's well-formed imeta entries.
///
/// Used as the keep-set when reconciling the index after a kind-40003 edit:
/// existing entries whose hash is absent here are retracted.
pub fn imeta_hash_set(event: &Event) -> HashSet<String> {
    parse_imeta_entries(event)
        .into_iter()
        .map(|e| e.sha256)
        .collect()
}

/// Tag/content payload for one derived kind-1063 event, ready to sign.
#[derive(Debug, Clone)]
pub struct FileIndexSpec {
    /// Event content: filename, else alt text, else empty.
    pub content: String,
    /// Full tag set (`url`/`m`/`x`/`size`, optional pass-throughs,
    /// `h`/`e`/`shared_at`/`uploader`).
    pub tags: Vec<Tag>,
    /// Blob hash, exposed for `(e, x)` dedup without re-parsing tags.
    pub sha256: String,
}

/// Derive the kind-1063 specs for `imeta_source`'s attachments.
///
/// `source_ref_hex` is the event id the entries reference via their `e`
/// tag: the event's own id for ordinary messages, the **edited target's**
/// id for kind-40003 edits — keeping the `(e, x)` identity stable across
/// edit chains. `uploader_hex` is the effective author (callers resolve
/// legacy relay-signed authorship). `shared_at_secs` is the source
/// message's `created_at`; the derived event's own `created_at` is left to
/// the signer (emission time) for replica-fence safety.
pub fn derive_file_index_specs(
    imeta_source: &Event,
    uploader_hex: &str,
    source_ref_hex: &str,
    shared_at_secs: u64,
    channel_id: &str,
) -> Vec<FileIndexSpec> {
    let mut specs = Vec::new();
    for entry in parse_imeta_entries(imeta_source) {
        let content = entry
            .filename
            .clone()
            .or_else(|| entry.alt.clone())
            .unwrap_or_default();

        let mut raw: Vec<Vec<String>> = vec![
            vec!["url".into(), entry.url.clone()],
            vec!["m".into(), entry.mime.clone()],
            vec!["x".into(), entry.sha256.clone()],
            vec!["size".into(), entry.size.clone()],
        ];
        for (key, value) in [
            ("dim", &entry.dim),
            ("blurhash", &entry.blurhash),
            ("thumb", &entry.thumb),
            ("duration", &entry.duration),
            ("filename", &entry.filename),
        ] {
            if let Some(v) = value {
                raw.push(vec![key.into(), v.clone()]);
            }
        }
        raw.push(vec!["h".into(), channel_id.to_string()]);
        raw.push(vec!["e".into(), source_ref_hex.to_string()]);
        raw.push(vec!["shared_at".into(), shared_at_secs.to_string()]);
        raw.push(vec!["uploader".into(), uploader_hex.to_string()]);

        let mut tags = Vec::with_capacity(raw.len());
        let mut ok = true;
        for parts in &raw {
            match Tag::parse(parts.iter().map(String::as_str)) {
                Ok(tag) => tags.push(tag),
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }

        specs.push(FileIndexSpec {
            content,
            tags,
            sha256: entry.sha256,
        });
    }
    specs
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind};

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn imeta_tag(parts: &[&str]) -> Tag {
        let mut v = vec!["imeta"];
        v.extend_from_slice(parts);
        Tag::parse(v).unwrap()
    }

    fn event_with_tags(tags: Vec<Tag>) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::Custom(9), "hello")
            .tags(tags)
            .sign_with_keys(&keys)
            .unwrap()
    }

    fn tag_value<'a>(tags: &'a [Tag], key: &str) -> Option<&'a str> {
        tags.iter().find_map(|t| {
            let parts = t.as_slice();
            (parts.first().map(String::as_str) == Some(key))
                .then(|| parts.get(1).map(String::as_str))
                .flatten()
        })
    }

    #[test]
    fn parses_full_and_minimal_entries() {
        let event = event_with_tags(vec![
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_A}.png"),
                "m image/png",
                &format!("x {HASH_A}"),
                "size 123",
                "dim 10x10",
                "filename cat.png",
            ]),
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_B}.pdf"),
                "m application/pdf",
                &format!("x {HASH_B}"),
                "size 456",
            ]),
        ]);
        let entries = parse_imeta_entries(&event);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].filename.as_deref(), Some("cat.png"));
        assert_eq!(entries[0].dim.as_deref(), Some("10x10"));
        assert_eq!(entries[1].mime, "application/pdf");
        assert!(entries[1].filename.is_none());
    }

    #[test]
    fn skips_malformed_entries() {
        let event = event_with_tags(vec![
            // missing size
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_A}.png"),
                "m image/png",
                &format!("x {HASH_A}"),
            ]),
            // bad hash
            imeta_tag(&[
                "url https://r.example/media/xyz.png",
                "m image/png",
                "x nothex",
                "size 1",
            ]),
            // non-http url
            imeta_tag(&[
                &format!("url ftp://r.example/{HASH_B}.png"),
                "m image/png",
                &format!("x {HASH_B}"),
                "size 1",
            ]),
            // non-numeric size
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_B}.png"),
                "m image/png",
                &format!("x {HASH_B}"),
                "size lots",
            ]),
        ]);
        assert!(parse_imeta_entries(&event).is_empty());
    }

    #[test]
    fn hash_set_collects_valid_hashes() {
        let event = event_with_tags(vec![
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_A}.png"),
                "m image/png",
                &format!("x {HASH_A}"),
                "size 1",
            ]),
            imeta_tag(&["url https://r.example/bad.png", "m image/png", "size 1"]),
        ]);
        let set = imeta_hash_set(&event);
        assert_eq!(set.len(), 1);
        assert!(set.contains(HASH_A));
    }

    #[test]
    fn derives_spec_with_index_tags_and_content_fallbacks() {
        let event = event_with_tags(vec![
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_A}.png"),
                "m image/png",
                &format!("x {HASH_A}"),
                "size 123",
                "thumb https://r.example/media/thumb.jpg",
                "filename cat.png",
            ]),
            imeta_tag(&[
                &format!("url https://r.example/media/{HASH_B}.mp4"),
                "m video/mp4",
                &format!("x {HASH_B}"),
                "size 999",
                "alt a video",
            ]),
        ]);
        let source_ref = event.id.to_hex();
        let uploader = event.pubkey.to_hex();
        let specs = derive_file_index_specs(&event, &uploader, &source_ref, 1700000000, "chan-1");

        assert_eq!(specs.len(), 2);
        // filename wins for content, alt is the fallback
        assert_eq!(specs[0].content, "cat.png");
        assert_eq!(specs[1].content, "a video");
        assert_eq!(specs[0].sha256, HASH_A);

        let tags = &specs[0].tags;
        assert_eq!(tag_value(tags, "x"), Some(HASH_A));
        assert_eq!(tag_value(tags, "h"), Some("chan-1"));
        assert_eq!(tag_value(tags, "e"), Some(source_ref.as_str()));
        assert_eq!(tag_value(tags, "shared_at"), Some("1700000000"));
        assert_eq!(tag_value(tags, "uploader"), Some(uploader.as_str()));
        assert_eq!(
            tag_value(tags, "thumb"),
            Some("https://r.example/media/thumb.jpg")
        );
        // deliberately no p tag — uploader attribution must not carry
        // mention/push semantics
        assert_eq!(tag_value(tags, "p"), None);
    }

    #[test]
    fn no_imeta_derives_nothing() {
        let event = event_with_tags(vec![Tag::parse(["h", "chan-1"]).unwrap()]);
        assert!(derive_file_index_specs(&event, "u", "e", 0, "chan-1").is_empty());
    }
}
