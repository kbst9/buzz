//! Durable delivery state: persisted per-channel completion watermarks plus a
//! bounded processed-event ring.
//!
//! Today the harness's durability boundary is the process lifetime — the
//! startup subscribe floor is `SystemTime::now()`, so a mention that arrives
//! while the unit is down, or is in-flight when the process is killed, is
//! silently lost. This module persists the per-channel *completion frontier*:
//! the newest `created_at` whose triggering events reached a durable end
//! (reply posted or dead-lettered — see [`crate::queue::TurnMeta`]). On
//! startup each channel's subscribe `since` is seeded from the persisted
//! watermark instead of process start, so anything past the frontier replays
//! through the normal live-subscription path (the relay REQ replay), the
//! normal filter gates, and the normal [`crate::queue::EventQueue`].
//!
//! Because the watermark advances only on durable completion — never on
//! receipt — a single mechanism covers both loss modes: downtime mentions and
//! in-flight-at-crash mentions are both "events newer than the frontier".
//!
//! The processed ring covers the replay tail: the subscribe path subtracts a
//! skew buffer from `since`, so the last completed batch's events are
//! re-delivered on every durable-delivery startup and must be dropped by id.
//! Net posture: exactly-once in steady state; at-least-once (a possible
//! duplicate reply, never a drop) only across the exact window between a
//! reply posting and the watermark write landing.
//!
//! ## Storage
//!
//! One JSON file per channel, `<dir>/<pubkey-prefix>-<channel-uuid>.json`,
//! written atomically (temp file + fsync + rename, best-effort directory
//! fsync). Writes are handed to a dedicated writer thread so no fsync ever
//! blocks the harness event loop; a lost write degrades to a slightly stale
//! watermark — replay, never loss. A torn or corrupt file is quarantined
//! (renamed `*.corrupt`) and its channel degrades to the startup watermark:
//! never a crash, never silent reuse of bad state.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::queue::TurnMeta;

/// Maximum processed-event entries retained per channel (newest kept).
///
/// Sized to comfortably exceed any realistic replay window: the subscribe
/// skew buffer is 5s and a batch delivers at most 50 events, so even a
/// pathological same-second burst stays far below this.
pub(crate) const SEEN_RING_CAP: usize = 512;

/// On-disk schema version. Files with a different version are quarantined
/// rather than guessed at.
const STATE_FILE_VERSION: u32 = 1;

/// Bound on the writer-thread queue. Completions arrive at agent-turn
/// cadence (seconds apart), so hitting this means the disk is badly wedged;
/// jobs are then dropped with a warning — a stale watermark replays, never
/// loses.
const WRITER_QUEUE_CAP: usize = 256;

/// How long shutdown waits for the writer thread to drain pending jobs.
const WRITER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// On-disk shape of one channel's delivery state.
#[derive(Debug, Serialize, Deserialize)]
struct ChannelStateFile {
    version: u32,
    /// Owning agent pubkey (hex). Guards against a nest being reused by a
    /// different identity: mismatching files are quarantined, not trusted.
    agent_pubkey: String,
    channel_id: Uuid,
    /// Completion frontier (unix seconds): newest `created_at` of the last
    /// durably completed batch, clamped below still-pending events.
    watermark: u64,
    /// Processed event ids, oldest→newest: `[event_id_hex, created_at]`.
    seen: Vec<(String, u64)>,
}

/// In-memory per-channel delivery state.
#[derive(Debug, Default)]
struct ChannelDelivery {
    watermark: u64,
    /// Processed ids, oldest at the front. `index` mirrors it for O(1) lookup.
    ring: VecDeque<(String, u64)>,
    index: HashSet<String>,
}

impl ChannelDelivery {
    fn push_seen(&mut self, id: String, created_at: u64) {
        if !self.index.insert(id.clone()) {
            return;
        }
        self.ring.push_back((id, created_at));
        while self.ring.len() > SEEN_RING_CAP {
            if let Some((old, _)) = self.ring.pop_front() {
                self.index.remove(&old);
            }
        }
    }
}

/// Synchronous core of the delivery store: in-memory state + (de)serialization.
///
/// IO-free except for [`load`](Self::load); mutation methods return the
/// `(path, bytes)` snapshot to persist so the async wrapper can hand it to
/// the writer thread. Pure enough to unit-test with a tempdir.
pub(crate) struct DeliveryState {
    dir: PathBuf,
    agent_pubkey: String,
    channels: HashMap<Uuid, ChannelDelivery>,
}

impl DeliveryState {
    /// Load persisted state from `dir`, creating the directory if needed.
    ///
    /// Corrupt, torn, foreign-identity, or wrong-version files are quarantined
    /// (renamed `*.corrupt`) with a warning; their channels degrade to
    /// never-seen. IO errors on individual files skip the file — only a
    /// directory-level failure is fatal to the caller (which then runs with
    /// durable delivery disabled).
    pub(crate) fn load(dir: PathBuf, agent_pubkey: String) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let mut channels = HashMap::new();
        let prefix = Self::file_prefix(&agent_pubkey);
        for entry in std::fs::read_dir(&dir)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !name.starts_with(&prefix) {
                // Another agent's state in a shared dir — leave untouched.
                continue;
            }
            match Self::parse_channel_file(&path, &agent_pubkey) {
                Ok((channel_id, state)) => {
                    channels.insert(channel_id, state);
                }
                Err(reason) => {
                    let quarantine = path.with_extension("corrupt");
                    let renamed = std::fs::rename(&path, &quarantine).is_ok();
                    tracing::warn!(
                        file = %path.display(),
                        %reason,
                        quarantined = renamed,
                        "durable-delivery state file unusable — channel degrades \
                         to the startup watermark"
                    );
                }
            }
        }
        Ok(Self {
            dir,
            agent_pubkey,
            channels,
        })
    }

    /// Filename prefix namespacing this agent's files in the state dir.
    fn file_prefix(agent_pubkey: &str) -> String {
        format!("{}-", &agent_pubkey[..agent_pubkey.len().min(16)])
    }

    fn channel_path(&self, channel_id: Uuid) -> PathBuf {
        self.dir.join(format!(
            "{}{channel_id}.json",
            Self::file_prefix(&self.agent_pubkey)
        ))
    }

    fn parse_channel_file(
        path: &Path,
        agent_pubkey: &str,
    ) -> Result<(Uuid, ChannelDelivery), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
        let file: ChannelStateFile =
            serde_json::from_slice(&bytes).map_err(|e| format!("parse failed: {e}"))?;
        if file.version != STATE_FILE_VERSION {
            return Err(format!("unsupported version {}", file.version));
        }
        if file.agent_pubkey != agent_pubkey {
            return Err("agent pubkey mismatch (nest reused by another identity?)".into());
        }
        let mut state = ChannelDelivery {
            watermark: file.watermark,
            ..Default::default()
        };
        for (id, ts) in file.seen {
            state.push_seen(id, ts);
        }
        Ok((file.channel_id, state))
    }

    fn serialize_channel(&self, channel_id: Uuid) -> (PathBuf, Vec<u8>) {
        let state = self.channels.get(&channel_id);
        let file = ChannelStateFile {
            version: STATE_FILE_VERSION,
            agent_pubkey: self.agent_pubkey.clone(),
            channel_id,
            watermark: state.map_or(0, |s| s.watermark),
            seen: state.map_or_else(Vec::new, |s| s.ring.iter().cloned().collect()),
        };
        let bytes = serde_json::to_vec(&file).unwrap_or_default();
        (self.channel_path(channel_id), bytes)
    }

    /// Number of channels with persisted state.
    pub(crate) fn channel_count(&self) -> usize {
        self.channels.len()
    }

    /// The persisted completion frontier for `channel_id`, if any.
    pub(crate) fn watermark(&self, channel_id: Uuid) -> Option<u64> {
        self.channels.get(&channel_id).map(|s| s.watermark)
    }

    /// Whether `event_id` was already durably processed for `channel_id`.
    pub(crate) fn is_seen(&self, channel_id: Uuid, event_id: &str) -> bool {
        self.channels
            .get(&channel_id)
            .is_some_and(|s| s.index.contains(event_id))
    }

    /// Startup subscribe floor for `channel_id`: the persisted watermark,
    /// clamped to the backfill look-back window (`cutoff` = now − max age).
    ///
    /// Returns `None` for channels with no persisted state — they keep the
    /// existing startup-watermark seeding. When the watermark predates the
    /// window, the clamp is logged loudly: events in the skipped span will
    /// NOT be replayed (bounded backfill, no silent truncation).
    pub(crate) fn startup_replay_since(&self, channel_id: Uuid, cutoff: u64) -> Option<u64> {
        let watermark = self.watermark(channel_id)?;
        if watermark < cutoff {
            tracing::warn!(
                %channel_id,
                watermark,
                clamped_since = cutoff,
                skipped_span_secs = cutoff - watermark,
                "startup backfill clamped to the look-back window — mentions \
                 older than the window are NOT replayed"
            );
            Some(cutoff)
        } else {
            Some(watermark)
        }
    }

    /// Advance the completion frontier for a durably completed turn and
    /// record its event ids as processed. Returns the file snapshot to
    /// persist.
    ///
    /// The advance target is `meta.advance_to` (already clamped below
    /// still-pending events by the queue) additionally clamped to `now` so a
    /// future-skewed sender clock cannot push the frontier ahead of honest
    /// timestamps. The frontier never regresses.
    pub(crate) fn record_turn_complete(
        &mut self,
        channel_id: Uuid,
        meta: &TurnMeta,
        now: u64,
    ) -> (PathBuf, Vec<u8>) {
        let state = self.channels.entry(channel_id).or_default();
        state.watermark = state.watermark.max(meta.advance_to.min(now));
        for (id, ts) in &meta.event_ids {
            state.push_seen(id.clone(), *ts);
        }
        self.serialize_channel(channel_id)
    }

    /// Create a channel's state at `floor` iff none exists yet. Returns the
    /// file snapshot to persist, or `None` when the channel already has state.
    ///
    /// Called at subscribe time so a channel's FIRST in-flight turn is
    /// already covered: without this, a kill before the channel's first
    /// durable completion leaves no file at all, and the next start would
    /// floor at process start — re-losing the in-flight mention.
    pub(crate) fn seed_channel_floor(
        &mut self,
        channel_id: Uuid,
        floor: u64,
    ) -> Option<(PathBuf, Vec<u8>)> {
        if self.channels.contains_key(&channel_id) {
            return None;
        }
        self.channels.insert(
            channel_id,
            ChannelDelivery {
                watermark: floor,
                ..Default::default()
            },
        );
        Some(self.serialize_channel(channel_id))
    }

    /// Advance a channel's frontier to at least `floor`, creating state if
    /// absent. Returns the file snapshot iff something changed.
    ///
    /// Used on a mid-run membership (re-)join: mentions sent while the agent
    /// was not a member are not its to answer (parity with today's
    /// drain-on-removal), so the frontier moves up to the join timestamp even
    /// past an older persisted watermark. Never regresses.
    pub(crate) fn advance_channel_floor(
        &mut self,
        channel_id: Uuid,
        floor: u64,
    ) -> Option<(PathBuf, Vec<u8>)> {
        let state = self.channels.entry(channel_id).or_default();
        if state.watermark >= floor {
            return None;
        }
        state.watermark = floor;
        Some(self.serialize_channel(channel_id))
    }

    /// Record event ids whose fate is decided without a completed turn (e.g.
    /// policy-dropped in `DedupMode::Drop`) so a restart replay does not
    /// resurrect them. Does not move the watermark. Returns the file
    /// snapshot to persist.
    pub(crate) fn record_seen(
        &mut self,
        channel_id: Uuid,
        entries: &[(String, u64)],
    ) -> (PathBuf, Vec<u8>) {
        let state = self.channels.entry(channel_id).or_default();
        for (id, ts) in entries {
            state.push_seen(id.clone(), *ts);
        }
        self.serialize_channel(channel_id)
    }
}

/// Atomically persist `bytes` at `path`: same-dir temp file, fsync, rename,
/// best-effort directory fsync. A crash at any point leaves either the old
/// file or the new one — never a torn mix.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Main-loop handle: in-memory state behind a mutex plus a dedicated writer
/// thread so persistence never blocks the harness event loop.
///
/// All methods take `&self`; locks are held only for in-memory mutation and
/// serialization (microseconds), never across IO or `.await`.
pub(crate) struct DeliveryHandle {
    state: std::sync::Mutex<DeliveryState>,
    writer_tx: std::sync::mpsc::SyncSender<(PathBuf, Vec<u8>)>,
    writer: std::thread::JoinHandle<()>,
}

impl DeliveryHandle {
    /// Load state from `dir` and start the writer thread.
    pub(crate) fn init(dir: PathBuf, agent_pubkey: String) -> std::io::Result<Self> {
        let state = DeliveryState::load(dir.clone(), agent_pubkey)?;
        tracing::info!(
            state_dir = %dir.display(),
            channels = state.channel_count(),
            "durable delivery enabled — loaded persisted watermarks"
        );
        let (writer_tx, writer_rx) =
            std::sync::mpsc::sync_channel::<(PathBuf, Vec<u8>)>(WRITER_QUEUE_CAP);
        let writer = std::thread::Builder::new()
            .name("buzz-acp-delivery".into())
            .spawn(move || {
                while let Ok((path, bytes)) = writer_rx.recv() {
                    if let Err(e) = write_atomic(&path, &bytes) {
                        tracing::warn!(
                            file = %path.display(),
                            "durable-delivery write failed: {e} — watermark \
                             stays stale (replays on restart, never loses)"
                        );
                    }
                }
            })?;
        Ok(Self {
            state: std::sync::Mutex::new(state),
            writer_tx,
            writer,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DeliveryState> {
        // Mutation happens only on the main-loop thread and the lock is
        // never held across a panic-prone section; recover a poisoned lock
        // rather than taking the harness down over delivery bookkeeping.
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn enqueue_write(&self, job: (PathBuf, Vec<u8>)) {
        if let Err(e) = self.writer_tx.try_send(job) {
            tracing::warn!(
                "durable-delivery writer queue full or closed ({e}) — dropping \
                 persist (watermark stays stale; replays on restart)"
            );
        }
    }

    /// See [`DeliveryState::startup_replay_since`].
    pub(crate) fn startup_replay_since(&self, channel_id: Uuid, cutoff: u64) -> Option<u64> {
        self.lock().startup_replay_since(channel_id, cutoff)
    }

    /// See [`DeliveryState::is_seen`].
    pub(crate) fn is_seen(&self, channel_id: Uuid, event_id: &str) -> bool {
        self.lock().is_seen(channel_id, event_id)
    }

    /// Persist a durable turn completion (watermark advance + seen ids).
    pub(crate) fn record_turn_complete(&self, channel_id: Uuid, meta: &TurnMeta) {
        let job = self
            .lock()
            .record_turn_complete(channel_id, meta, unix_now_secs());
        self.enqueue_write(job);
    }

    /// Persist decided-fate event ids without advancing the watermark.
    pub(crate) fn record_seen(&self, channel_id: Uuid, entries: &[(String, u64)]) {
        let job = self.lock().record_seen(channel_id, entries);
        self.enqueue_write(job);
    }

    /// See [`DeliveryState::seed_channel_floor`].
    pub(crate) fn seed_channel_floor(&self, channel_id: Uuid, floor: u64) {
        if let Some(job) = self.lock().seed_channel_floor(channel_id, floor) {
            self.enqueue_write(job);
        }
    }

    /// See [`DeliveryState::advance_channel_floor`].
    pub(crate) fn advance_channel_floor(&self, channel_id: Uuid, floor: u64) {
        if let Some(job) = self.lock().advance_channel_floor(channel_id, floor) {
            self.enqueue_write(job);
        }
    }

    /// Drop the sender and give the writer thread a bounded window to drain
    /// pending persists. Called from the harness shutdown path.
    pub(crate) async fn shutdown(self) {
        let Self {
            writer_tx, writer, ..
        } = self;
        drop(writer_tx);
        let join = tokio::task::spawn_blocking(move || {
            let _ = writer.join();
        });
        if tokio::time::timeout(WRITER_SHUTDOWN_TIMEOUT, join)
            .await
            .is_err()
        {
            tracing::warn!("durable-delivery writer did not drain in time — pending persists lost (replay on next start)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(ids: &[(&str, u64)]) -> TurnMeta {
        let event_ids: Vec<(String, u64)> =
            ids.iter().map(|(id, ts)| (id.to_string(), *ts)).collect();
        let max = event_ids.iter().map(|(_, ts)| *ts).max().unwrap_or(0);
        TurnMeta {
            event_ids,
            max_created_at: max,
            advance_to: max,
        }
    }

    const PK: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    #[test]
    fn round_trips_watermark_and_seen_across_load() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();

        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        let (path, bytes) = s.record_turn_complete(ch, &meta(&[("e1", 100), ("e2", 105)]), 1_000);
        write_atomic(&path, &bytes).unwrap();

        let reloaded = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        assert_eq!(reloaded.watermark(ch), Some(105));
        assert!(reloaded.is_seen(ch, "e1"));
        assert!(reloaded.is_seen(ch, "e2"));
        assert!(!reloaded.is_seen(ch, "e3"));
    }

    #[test]
    fn watermark_never_regresses_and_clamps_future_skew() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();

        s.record_turn_complete(ch, &meta(&[("new", 500)]), 1_000);
        // An older batch completing later must not move the frontier back.
        s.record_turn_complete(ch, &meta(&[("old", 200)]), 1_000);
        assert_eq!(s.watermark(ch), Some(500));

        // A future-skewed sender clock is clamped to local now.
        s.record_turn_complete(ch, &meta(&[("skewed", 9_999)]), 1_000);
        assert_eq!(s.watermark(ch), Some(1_000));
    }

    #[test]
    fn seen_ring_evicts_oldest_beyond_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();

        for i in 0..(SEEN_RING_CAP + 10) {
            s.record_seen(ch, &[(format!("e{i}"), i as u64)]);
        }
        assert!(!s.is_seen(ch, "e0"), "oldest entries must be evicted");
        assert!(!s.is_seen(ch, "e9"));
        assert!(s.is_seen(ch, "e10"), "entries within cap must remain");
        assert!(s.is_seen(ch, &format!("e{}", SEEN_RING_CAP + 9)));
        assert_eq!(s.channels.get(&ch).unwrap().ring.len(), SEEN_RING_CAP);
        assert_eq!(s.channels.get(&ch).unwrap().index.len(), SEEN_RING_CAP);
    }

    #[test]
    fn duplicate_seen_ids_are_not_double_counted() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();

        s.record_seen(ch, &[("dup".into(), 1)]);
        s.record_seen(ch, &[("dup".into(), 1)]);
        assert_eq!(s.channels.get(&ch).unwrap().ring.len(), 1);
    }

    #[test]
    fn corrupt_file_is_quarantined_and_channel_degrades() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();

        // A healthy sibling channel proves isolation.
        let healthy = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        let (hp, hb) = s.record_turn_complete(healthy, &meta(&[("ok", 50)]), 1_000);
        write_atomic(&hp, &hb).unwrap();

        // Torn write: truncated JSON for `ch`.
        let corrupt_path = s.channel_path(ch);
        std::fs::write(&corrupt_path, br#"{"version":1,"agent_pu"#).unwrap();

        let reloaded = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        assert_eq!(reloaded.watermark(ch), None, "corrupt channel starts fresh");
        assert_eq!(
            reloaded.watermark(healthy),
            Some(50),
            "healthy channel kept"
        );
        assert!(
            corrupt_path.with_extension("corrupt").exists(),
            "corrupt file must be quarantined, not deleted"
        );
        assert!(!corrupt_path.exists());
    }

    #[test]
    fn foreign_identity_file_is_not_trusted() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();

        // File named with our prefix but recording another agent's pubkey.
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        let (path, _) = s.record_seen(ch, &[]);
        let other = ChannelStateFile {
            version: STATE_FILE_VERSION,
            agent_pubkey: "ff".repeat(32),
            channel_id: ch,
            watermark: 777,
            seen: vec![],
        };
        std::fs::write(&path, serde_json::to_vec(&other).unwrap()).unwrap();

        let reloaded = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        assert_eq!(reloaded.watermark(ch), None);
    }

    #[test]
    fn startup_replay_since_clamps_to_lookback_window() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();

        assert_eq!(s.startup_replay_since(ch, 500), None, "no state → None");

        s.record_turn_complete(ch, &meta(&[("e", 100)]), 1_000);
        assert_eq!(
            s.startup_replay_since(ch, 500),
            Some(500),
            "watermark below the window clamps to the cutoff"
        );
        assert_eq!(
            s.startup_replay_since(ch, 50),
            Some(100),
            "watermark inside the window is used as-is"
        );
    }

    #[test]
    fn seed_channel_floor_creates_once_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();

        assert!(
            s.seed_channel_floor(ch, 1_000).is_some(),
            "first seed writes"
        );
        assert_eq!(s.watermark(ch), Some(1_000));

        // A later seed (e.g. next startup) must not move an existing
        // frontier — that would erase the backfill window.
        assert!(s.seed_channel_floor(ch, 2_000).is_none());
        assert_eq!(s.watermark(ch), Some(1_000));

        // Completion still advances normally from a seeded floor.
        s.record_turn_complete(ch, &meta(&[("e", 1_500)]), 9_000);
        assert_eq!(s.watermark(ch), Some(1_500));
    }

    #[test]
    fn advance_channel_floor_moves_forward_only() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();
        let mut s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();

        assert!(
            s.advance_channel_floor(ch, 500).is_some(),
            "creates if absent"
        );
        assert!(
            s.advance_channel_floor(ch, 800).is_some(),
            "re-join past the old frontier advances"
        );
        assert_eq!(s.watermark(ch), Some(800));
        assert!(
            s.advance_channel_floor(ch, 300).is_none(),
            "never regresses"
        );
        assert_eq!(s.watermark(ch), Some(800));
    }

    #[test]
    fn tmp_and_corrupt_files_are_ignored_on_load() {
        let tmp = tempfile::tempdir().unwrap();
        let prefix = DeliveryState::file_prefix(PK);
        std::fs::write(
            tmp.path()
                .join(format!("{prefix}{}.json.tmp", Uuid::new_v4())),
            b"partial",
        )
        .unwrap();
        std::fs::write(
            tmp.path()
                .join(format!("{prefix}{}.corrupt", Uuid::new_v4())),
            b"old corpse",
        )
        .unwrap();

        let s = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        assert_eq!(s.channel_count(), 0);
    }

    #[tokio::test]
    async fn handle_persists_via_writer_thread() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = Uuid::new_v4();

        let handle = DeliveryHandle::init(tmp.path().to_path_buf(), PK.into()).unwrap();
        handle.record_turn_complete(ch, &meta(&[("e1", 42)]));
        assert!(
            handle.is_seen(ch, "e1"),
            "in-memory state updates immediately"
        );
        handle.shutdown().await;

        let reloaded = DeliveryState::load(tmp.path().to_path_buf(), PK.into()).unwrap();
        assert_eq!(reloaded.watermark(ch), Some(42));
        assert!(reloaded.is_seen(ch, "e1"));
    }
}
