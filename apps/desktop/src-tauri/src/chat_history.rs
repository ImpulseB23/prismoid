//! On-disk chat log. Twitch sends no backlog when a chat is joined, so the
//! app keeps its own: every message batch the drain loop emits is also
//! written to a SQLite file in the app data directory, and the feed loads
//! the stored tail when a channel opens. Moderation events mark stored rows
//! deleted so history renders the way the live view did.
//!
//! A SQLite connection belongs to one thread, so a dedicated thread owns it
//! and the rest of the host talks to it through a channel. Writes never
//! block the drain loop; a load answers over a oneshot.

use std::collections::HashMap;
use std::error::Error;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::oneshot;

use crate::message::{ChatEvent, UnifiedMessage};

/// Newest rows kept per channel; older ones go once this is exceeded.
const KEEP_PER_CHANNEL: i64 = 10_000;
/// Rows older than this go at startup regardless of count.
const KEEP_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Inserts into one channel between count prunes of it.
const PRUNE_EVERY: u32 = 256;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS messages (
    channel_id   TEXT    NOT NULL,
    message_id   TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    effective_ts INTEGER NOT NULL,
    arrival_seq  INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0,
    body         TEXT    NOT NULL,
    PRIMARY KEY (channel_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_by_time ON messages (channel_id, effective_ts, arrival_seq);
CREATE INDEX IF NOT EXISTS messages_by_user ON messages (channel_id, user_id);
";

/// A stored message as the feed receives it: the wire shape plus whether a
/// moderator removed it after it was shown.
#[derive(Debug, Clone, Serialize)]
pub struct StoredMessage {
    #[serde(flatten)]
    pub message: UnifiedMessage,
    pub deleted: bool,
}

type Reply = oneshot::Sender<Vec<StoredMessage>>;

enum Op {
    Store(Vec<UnifiedMessage>),
    Apply(Vec<ChatEvent>),
    Load {
        channel_id: String,
        limit: u32,
        reply: Reply,
    },
    ImportBegin(String),
    Import {
        channel_id: String,
        rows: Vec<StoredMessage>,
    },
}

/// Handle to the history thread. Empty when the store could not be opened,
/// in which case writes are dropped and loads come back empty so the feed
/// still works without a backlog.
#[derive(Clone, Default)]
pub struct History {
    tx: Option<mpsc::Sender<Op>>,
}

impl History {
    /// Opens (or creates) `chat.sqlite3` under `dir` and starts the owning
    /// thread.
    pub fn open(dir: &Path) -> Result<Self, Box<dyn Error + Send + Sync>> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("chat.sqlite3"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("chat-history".into())
            .spawn(move || Store::new(conn).run(rx))?;
        Ok(Self { tx: Some(tx) })
    }

    pub fn store(&self, batch: &[UnifiedMessage]) {
        self.send(Op::Store(batch.to_vec()));
    }

    pub fn apply(&self, events: &[ChatEvent]) {
        self.send(Op::Apply(events.to_vec()));
    }

    /// Announces a backlog import for `channel_id`; loads of that channel
    /// wait until the matching [`History::import`] arrives.
    pub fn begin_import(&self, channel_id: String) {
        self.send(Op::ImportBegin(channel_id));
    }

    /// Stores rows fetched from outside the live feed and releases the
    /// loads waiting on them. Rows already logged keep their copy and only
    /// pick up a deletion.
    pub fn import(&self, channel_id: String, rows: Vec<StoredMessage>) {
        self.send(Op::Import { channel_id, rows });
    }

    /// The newest `limit` rows of a channel, oldest first.
    pub async fn load(&self, channel_id: String, limit: u32) -> Vec<StoredMessage> {
        let Some(tx) = &self.tx else {
            return Vec::new();
        };
        let (reply, rx) = oneshot::channel();
        if tx
            .send(Op::Load {
                channel_id,
                limit,
                reply,
            })
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    fn send(&self, op: Op) {
        // The thread only stops once every sender is gone, so a failed send
        // here means it panicked and the error is already in the log.
        if let Some(tx) = &self.tx {
            let _ = tx.send(op);
        }
    }
}

#[tauri::command]
pub async fn chat_history<R: Runtime>(
    app: AppHandle<R>,
    channel_id: String,
    limit: u32,
) -> Vec<StoredMessage> {
    let history = app.state::<History>().inner().clone();
    history.load(channel_id, limit).await
}

struct Store {
    conn: Connection,
    /// Inserts per channel since its last count prune.
    inserts: HashMap<String, u32>,
    /// Imports announced but not yet delivered, per channel.
    importing: HashMap<String, u32>,
    /// Loads parked until their channel's imports are in.
    waiting: HashMap<String, Vec<(u32, Reply)>>,
}

impl Store {
    fn new(conn: Connection) -> Self {
        Self {
            conn,
            inserts: HashMap::new(),
            importing: HashMap::new(),
            waiting: HashMap::new(),
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Op>) {
        if let Err(e) = self.prune_old(chrono::Utc::now().timestamp_millis()) {
            tracing::error!(error = %e, "chat history age prune failed");
        }
        for op in rx {
            self.handle(op);
        }
    }

    fn handle(&mut self, op: Op) {
        let result = match op {
            Op::Store(batch) => self.store(&batch),
            Op::Apply(events) => self.apply(&events),
            Op::Load {
                channel_id,
                limit,
                reply,
            } => {
                if self.importing.contains_key(&channel_id) {
                    self.waiting
                        .entry(channel_id)
                        .or_default()
                        .push((limit, reply));
                } else {
                    self.answer(&channel_id, limit, reply);
                }
                Ok(())
            }
            Op::ImportBegin(channel_id) => {
                *self.importing.entry(channel_id).or_insert(0) += 1;
                Ok(())
            }
            Op::Import { channel_id, rows } => {
                let result = self.import(&rows);
                let outstanding = self.importing.get_mut(&channel_id).map(|n| {
                    *n -= 1;
                    *n
                });
                if outstanding == Some(0) {
                    self.importing.remove(&channel_id);
                    for (limit, reply) in self.waiting.remove(&channel_id).unwrap_or_default() {
                        self.answer(&channel_id, limit, reply);
                    }
                }
                result
            }
        };
        if let Err(e) = result {
            tracing::error!(error = %e, "chat history write failed");
        }
    }

    fn answer(&self, channel_id: &str, limit: u32, reply: Reply) {
        let rows = self.load(channel_id, limit).unwrap_or_else(|e| {
            tracing::error!(error = %e, channel_id, "chat history load failed");
            Vec::new()
        });
        let _ = reply.send(rows);
    }

    fn import(&mut self, rows: &[StoredMessage]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut upsert = tx.prepare_cached(
                "INSERT INTO messages \
                 (channel_id, message_id, user_id, effective_ts, arrival_seq, deleted, body) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT (channel_id, message_id) \
                 DO UPDATE SET deleted = max(deleted, excluded.deleted)",
            )?;
            for row in rows {
                let m = &row.message;
                let body = serde_json::to_string(m)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                let seq = i64::try_from(m.arrival_seq)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                upsert.execute(params![
                    m.channel_id,
                    m.id,
                    m.platform_user_id,
                    m.effective_ts,
                    seq,
                    row.deleted,
                    body
                ])?;
            }
        }
        tx.commit()
    }

    fn store(&mut self, batch: &[UnifiedMessage]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT OR IGNORE INTO messages \
                 (channel_id, message_id, user_id, effective_ts, arrival_seq, body) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for m in batch {
                let body = serde_json::to_string(m)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                let seq = i64::try_from(m.arrival_seq)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                insert.execute(params![
                    m.channel_id,
                    m.id,
                    m.platform_user_id,
                    m.effective_ts,
                    seq,
                    body
                ])?;
            }
        }
        tx.commit()?;

        for m in batch {
            let n = self.inserts.entry(m.channel_id.clone()).or_insert(0);
            *n += 1;
            if *n >= PRUNE_EVERY {
                *n = 0;
                self.prune_channel(&m.channel_id, KEEP_PER_CHANNEL)?;
            }
        }
        Ok(())
    }

    fn apply(&mut self, events: &[ChatEvent]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        for e in events {
            match e {
                ChatEvent::MessageDeleted {
                    channel_id,
                    message_id,
                    ..
                } => {
                    tx.execute(
                        "UPDATE messages SET deleted = 1 WHERE channel_id = ?1 AND message_id = ?2",
                        params![channel_id, message_id],
                    )?;
                }
                ChatEvent::UserCleared {
                    channel_id,
                    target_user_id,
                    ..
                } => {
                    tx.execute(
                        "UPDATE messages SET deleted = 1 WHERE channel_id = ?1 AND user_id = ?2",
                        params![channel_id, target_user_id],
                    )?;
                }
                ChatEvent::ChatCleared { channel_id } => {
                    tx.execute(
                        "UPDATE messages SET deleted = 1 WHERE channel_id = ?1",
                        params![channel_id],
                    )?;
                }
                ChatEvent::ModAction(_) => {}
            }
        }
        tx.commit()
    }

    fn load(&self, channel_id: &str, limit: u32) -> rusqlite::Result<Vec<StoredMessage>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT body, deleted FROM messages WHERE channel_id = ?1 \
             ORDER BY effective_ts DESC, arrival_seq DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![channel_id, limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (body, deleted) = row?;
            // A row written by an older build with a different message
            // shape is skipped rather than failing the whole load.
            match serde_json::from_str(&body) {
                Ok(message) => out.push(StoredMessage { message, deleted }),
                Err(e) => tracing::warn!(error = %e, "skipping unreadable history row"),
            }
        }
        out.reverse();
        Ok(out)
    }

    /// Drops every row of `channel_id` except the newest `keep`.
    fn prune_channel(&self, channel_id: &str, keep: i64) -> rusqlite::Result<()> {
        let cutoff = self
            .conn
            .query_row(
                "SELECT effective_ts, arrival_seq FROM messages WHERE channel_id = ?1 \
                 ORDER BY effective_ts DESC, arrival_seq DESC LIMIT 1 OFFSET ?2",
                params![channel_id, keep],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        if let Some((ts, seq)) = cutoff {
            self.conn.execute(
                "DELETE FROM messages WHERE channel_id = ?1 \
                 AND (effective_ts, arrival_seq) <= (?2, ?3)",
                params![channel_id, ts, seq],
            )?;
        }
        Ok(())
    }

    fn prune_old(&self, now_ms: i64) -> rusqlite::Result<()> {
        let keep_ms = i64::try_from(KEEP_FOR.as_millis()).expect("retention fits in i64 ms");
        self.conn.execute(
            "DELETE FROM messages WHERE effective_ts < ?1",
            params![now_ms - keep_ms],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::Platform;

    fn store() -> Store {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        Store::new(conn)
    }

    fn msg(id: &str, channel: &str, user: &str, ts: i64, seq: u64) -> UnifiedMessage {
        UnifiedMessage {
            id: id.into(),
            platform: Platform::Twitch,
            timestamp: ts,
            arrival_time: ts,
            effective_ts: ts,
            arrival_seq: seq,
            username: user.into(),
            display_name: user.to_uppercase(),
            platform_user_id: user.into(),
            channel_id: channel.into(),
            message_text: format!("hello {id}"),
            badges: Vec::new(),
            is_mod: false,
            is_subscriber: false,
            is_broadcaster: false,
            color: None,
            reply_to: None,
            reply_parent: None,
            notice: None,
            emote_spans: Vec::new(),
        }
    }

    fn ids(rows: &[StoredMessage]) -> Vec<&str> {
        rows.iter().map(|r| r.message.id.as_str()).collect()
    }

    #[test]
    fn load_returns_newest_rows_oldest_first() {
        let mut s = store();
        s.store(&[
            msg("a", "c", "u1", 1, 0),
            msg("b", "c", "u1", 2, 1),
            msg("c", "c", "u2", 3, 2),
            msg("x", "other", "u1", 4, 3),
        ])
        .unwrap();
        let rows = s.load("c", 2).unwrap();
        assert_eq!(ids(&rows), ["b", "c"]);
        assert!(rows.iter().all(|r| !r.deleted));
        assert_eq!(rows[1].message.message_text, "hello c");
    }

    #[test]
    fn redelivered_message_is_stored_once() {
        let mut s = store();
        s.store(&[msg("a", "c", "u1", 1, 0)]).unwrap();
        s.store(&[msg("a", "c", "u1", 1, 5)]).unwrap();
        assert_eq!(ids(&s.load("c", 10).unwrap()), ["a"]);
    }

    #[test]
    fn moderation_events_mark_rows_deleted() {
        let mut s = store();
        s.store(&[
            msg("a", "c", "u1", 1, 0),
            msg("b", "c", "u2", 2, 1),
            msg("c", "c", "u2", 3, 2),
            msg("d", "other", "u2", 4, 3),
        ])
        .unwrap();
        s.apply(&[
            ChatEvent::MessageDeleted {
                channel_id: "c".into(),
                message_id: "a".into(),
                target_user_id: "u1".into(),
            },
            ChatEvent::UserCleared {
                channel_id: "c".into(),
                target_user_id: "u2".into(),
                target_user_login: "u2".into(),
                target_user_name: "U2".into(),
            },
        ])
        .unwrap();
        let deleted: Vec<bool> = s.load("c", 10).unwrap().iter().map(|r| r.deleted).collect();
        assert_eq!(deleted, [true, true, true]);
        assert!(!s.load("other", 10).unwrap()[0].deleted);

        s.apply(&[ChatEvent::ChatCleared {
            channel_id: "other".into(),
        }])
        .unwrap();
        assert!(s.load("other", 10).unwrap()[0].deleted);
    }

    #[test]
    fn prune_keeps_newest_rows_of_the_channel() {
        let mut s = store();
        let batch: Vec<_> = (0..6)
            .map(|i| msg(&format!("m{i}"), "c", "u", i, i as u64))
            .collect();
        s.store(&batch).unwrap();
        s.store(&[msg("o", "other", "u", 0, 9)]).unwrap();
        s.prune_channel("c", 2).unwrap();
        assert_eq!(ids(&s.load("c", 10).unwrap()), ["m4", "m5"]);
        assert_eq!(ids(&s.load("other", 10).unwrap()), ["o"]);
    }

    fn load_op(channel: &str) -> (Op, oneshot::Receiver<Vec<StoredMessage>>) {
        let (reply, rx) = oneshot::channel();
        (
            Op::Load {
                channel_id: channel.into(),
                limit: 10,
                reply,
            },
            rx,
        )
    }

    #[test]
    fn load_waits_for_a_pending_import() {
        let mut s = store();
        s.store(&[msg("live", "c", "u", 5, 0)]).unwrap();
        s.handle(Op::ImportBegin("c".into()));
        let (load, mut rx) = load_op("c");
        s.handle(load);
        assert!(rx.try_recv().is_err());

        let (other, mut other_rx) = load_op("other");
        s.handle(other);
        assert!(other_rx.try_recv().unwrap().is_empty());

        s.handle(Op::Import {
            channel_id: "c".into(),
            rows: vec![StoredMessage {
                message: msg("old", "c", "u", 1, 0),
                deleted: false,
            }],
        });
        assert_eq!(ids(&rx.try_recv().unwrap()), ["old", "live"]);

        let (after, mut after_rx) = load_op("c");
        s.handle(after);
        assert_eq!(after_rx.try_recv().unwrap().len(), 2);
    }

    #[test]
    fn two_imports_release_loads_only_after_both() {
        let mut s = store();
        s.handle(Op::ImportBegin("c".into()));
        s.handle(Op::ImportBegin("c".into()));
        let (load, mut rx) = load_op("c");
        s.handle(load);
        s.handle(Op::Import {
            channel_id: "c".into(),
            rows: Vec::new(),
        });
        assert!(rx.try_recv().is_err());
        s.handle(Op::Import {
            channel_id: "c".into(),
            rows: Vec::new(),
        });
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn import_keeps_logged_rows_and_adds_deletions() {
        let mut s = store();
        s.store(&[msg("a", "c", "u", 1, 0), msg("b", "c", "u", 2, 1)])
            .unwrap();
        let mut dup = msg("a", "c", "u", 1, 0);
        dup.message_text = "from the service".into();
        s.import(&[
            StoredMessage {
                message: dup,
                deleted: true,
            },
            StoredMessage {
                message: msg("z", "c", "u", 0, 0),
                deleted: false,
            },
        ])
        .unwrap();
        let rows = s.load("c", 10).unwrap();
        assert_eq!(ids(&rows), ["z", "a", "b"]);
        assert!(rows[1].deleted);
        assert_eq!(rows[1].message.message_text, "hello a");
    }

    #[test]
    fn age_prune_drops_rows_older_than_retention() {
        let mut s = store();
        let now = 1_000_000_000_000;
        let keep = i64::try_from(KEEP_FOR.as_millis()).unwrap();
        s.store(&[
            msg("old", "c", "u", now - keep - 1, 0),
            msg("new", "c", "u", now - keep + 1, 1),
        ])
        .unwrap();
        s.prune_old(now).unwrap();
        assert_eq!(ids(&s.load("c", 10).unwrap()), ["new"]);
    }
}
