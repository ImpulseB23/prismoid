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

const FILE_NAME: &str = "chat.sqlite3";
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
-- Replaced by messages_by_user_time, which also serves the user card in order.
DROP INDEX IF EXISTS messages_by_user;
CREATE INDEX IF NOT EXISTS messages_by_user_time ON messages (channel_id, user_id, effective_ts, arrival_seq);
CREATE INDEX IF NOT EXISTS messages_by_author ON messages (user_id, effective_ts);
-- Messages Twitch flagged as a chatter's first in the channel. Kept apart
-- from `messages` so a flag can land before or after its message.
CREATE TABLE IF NOT EXISTS first_messages (
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (channel_id, message_id)
) WITHOUT ROWID;
";

/// A stored message as the feed receives it: the wire shape plus whether a
/// moderator removed it after it was shown and whether it was the chatter's
/// first message in the channel.
#[derive(Debug, Clone, Serialize)]
pub struct StoredMessage {
    #[serde(flatten)]
    pub message: UnifiedMessage,
    pub deleted: bool,
    pub first_message: bool,
}

type Reply = oneshot::Sender<Vec<StoredMessage>>;

/// Which rows of a channel a load reads.
enum Query {
    Tail,
    /// Only what this user wrote.
    User(String),
}

enum Op {
    Store(Vec<UnifiedMessage>),
    Apply(Vec<ChatEvent>),
    Load {
        channel_id: String,
        query: Query,
        limit: u32,
        reply: Reply,
    },
    ImportBegin(String),
    MarkFirst {
        channel_id: String,
        message_id: String,
    },
    Import {
        channel_id: String,
        rows: Vec<StoredMessage>,
    },
    SentCounts {
        user_id: String,
        since_ms: i64,
        reply: oneshot::Sender<HashMap<String, u32>>,
    },
}

enum Msg {
    Op(Op),
    /// Closes the database and ends the thread, then answers with how the
    /// close went.
    Close(oneshot::Sender<rusqlite::Result<()>>),
}

/// Handle to the history thread. Empty when the store could not be opened,
/// in which case writes are dropped and loads come back empty so the feed
/// still works without a backlog.
#[derive(Clone, Default)]
pub struct History {
    tx: Option<mpsc::Sender<Msg>>,
}

impl History {
    /// Opens (or creates) `chat.sqlite3` under `dir` and starts the owning
    /// thread.
    pub fn open(dir: &Path) -> Result<Self, Box<dyn Error + Send + Sync>> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join(FILE_NAME))?;
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

    /// Remembers that Twitch flagged a message as its chatter's first in the
    /// channel, so the mark survives reloads and restarts.
    pub fn mark_first(&self, channel_id: String, message_id: String) {
        self.send(Op::MarkFirst {
            channel_id,
            message_id,
        });
    }

    /// The newest `limit` rows of a channel, oldest first.
    pub async fn load(&self, channel_id: String, limit: u32) -> Vec<StoredMessage> {
        self.query(channel_id, Query::Tail, limit).await
    }

    /// The newest `limit` rows `user_id` wrote in a channel, oldest first.
    pub async fn load_user(
        &self,
        channel_id: String,
        user_id: String,
        limit: u32,
    ) -> Vec<StoredMessage> {
        self.query(channel_id, Query::User(user_id), limit).await
    }

    async fn query(&self, channel_id: String, query: Query, limit: u32) -> Vec<StoredMessage> {
        let Some(tx) = &self.tx else {
            return Vec::new();
        };
        let (reply, rx) = oneshot::channel();
        if tx
            .send(Msg::Op(Op::Load {
                channel_id,
                query,
                limit,
                reply,
            }))
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Messages `user_id` wrote per channel since `since_ms`, for ranking
    /// the channels they chat in.
    pub async fn sent_counts(&self, user_id: String, since_ms: i64) -> HashMap<String, u32> {
        let Some(tx) = &self.tx else {
            return HashMap::new();
        };
        let (reply, rx) = oneshot::channel();
        if tx
            .send(Msg::Op(Op::SentCounts {
                user_id,
                since_ms,
                reply,
            }))
            .is_err()
        {
            return HashMap::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Closes the database for good and waits until its files are released,
    /// so they can be deleted. Every handle goes quiet afterwards: writes
    /// are dropped and loads come back empty. A store that never opened or
    /// is already closed has nothing to release.
    pub async fn close(&self) -> rusqlite::Result<()> {
        let (done, rx) = oneshot::channel();
        match &self.tx {
            Some(tx) if tx.send(Msg::Close(done)).is_ok() => rx.await.unwrap_or(Ok(())),
            _ => Ok(()),
        }
    }

    fn send(&self, op: Op) {
        // The thread only stops once closed or once every sender is gone, so
        // a failed send means it was closed or panicked; a panic is already
        // in the log.
        if let Some(tx) = &self.tx {
            let _ = tx.send(Msg::Op(op));
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

/// What one user said recently in a channel, for their user card.
#[tauri::command]
pub async fn chat_history_user<R: Runtime>(
    app: AppHandle<R>,
    channel_id: String,
    user_id: String,
    limit: u32,
) -> Vec<StoredMessage> {
    let history = app.state::<History>().inner().clone();
    history.load_user(channel_id, user_id, limit).await
}

struct Store {
    conn: Connection,
    /// Inserts per channel since its last count prune.
    inserts: HashMap<String, u32>,
    /// Imports announced but not yet delivered, per channel.
    importing: HashMap<String, u32>,
    /// Loads parked until their channel's imports are in.
    waiting: HashMap<String, Vec<(Query, u32, Reply)>>,
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

    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        if let Err(e) = self.prune_old(chrono::Utc::now().timestamp_millis()) {
            tracing::error!(error = %e, "chat history age prune failed");
        }
        for msg in rx {
            match msg {
                Msg::Op(op) => self.handle(op),
                Msg::Close(done) => {
                    // Closing the last connection checkpoints the WAL and
                    // removes its side files. Parked loads get dropped
                    // replies, which read as empty.
                    let _ = done.send(self.conn.close().map_err(|(_, e)| e));
                    return;
                }
            }
        }
    }

    fn handle(&mut self, op: Op) {
        let result = match op {
            Op::Store(batch) => self.store(&batch),
            Op::Apply(events) => self.apply(&events),
            Op::Load {
                channel_id,
                query,
                limit,
                reply,
            } => {
                if self.importing.contains_key(&channel_id) {
                    self.waiting
                        .entry(channel_id)
                        .or_default()
                        .push((query, limit, reply));
                } else {
                    self.answer(&channel_id, &query, limit, reply);
                }
                Ok(())
            }
            Op::MarkFirst {
                channel_id,
                message_id,
            } => self
                .conn
                .execute(
                    "INSERT OR IGNORE INTO first_messages (channel_id, message_id) VALUES (?1, ?2)",
                    params![channel_id, message_id],
                )
                .map(|_| ()),
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
                    for (query, limit, reply) in
                        self.waiting.remove(&channel_id).unwrap_or_default()
                    {
                        self.answer(&channel_id, &query, limit, reply);
                    }
                }
                result
            }
            Op::SentCounts {
                user_id,
                since_ms,
                reply,
            } => {
                let counts = self.sent_counts(&user_id, since_ms).unwrap_or_else(|e| {
                    tracing::error!(error = %e, "chat history count failed");
                    HashMap::new()
                });
                let _ = reply.send(counts);
                Ok(())
            }
        };
        if let Err(e) = result {
            tracing::error!(error = %e, "chat history write failed");
        }
    }

    fn answer(&self, channel_id: &str, query: &Query, limit: u32, reply: Reply) {
        let rows = match query {
            Query::Tail => self.load(channel_id, limit),
            Query::User(user_id) => self.load_user(channel_id, user_id, limit),
        };
        let rows = rows.unwrap_or_else(|e| {
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
            let mut first = tx.prepare_cached(
                "INSERT OR IGNORE INTO first_messages (channel_id, message_id) VALUES (?1, ?2)",
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
                if row.first_message {
                    first.execute(params![m.channel_id, m.id])?;
                }
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
                ChatEvent::ModAction(_)
                | ChatEvent::AutomodHeld(_)
                | ChatEvent::AutomodResolved { .. }
                | ChatEvent::PollUpdate(_)
                | ChatEvent::PredictionUpdate(_)
                | ChatEvent::AdBreak(_)
                | ChatEvent::ChatSettings { .. } => {}
            }
        }
        tx.commit()
    }

    fn load(&self, channel_id: &str, limit: u32) -> rusqlite::Result<Vec<StoredMessage>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT m.body, m.deleted, f.message_id IS NOT NULL FROM messages m \
             LEFT JOIN first_messages f \
             ON f.channel_id = m.channel_id AND f.message_id = m.message_id \
             WHERE m.channel_id = ?1 \
             ORDER BY m.effective_ts DESC, m.arrival_seq DESC LIMIT ?2",
        )?;
        read_newest_first(&mut stmt, params![channel_id, limit])
    }

    /// Walks `messages_by_user_time` backwards from the user's newest row in
    /// the channel, so it stops after `limit` rows without sorting.
    fn load_user(
        &self,
        channel_id: &str,
        user_id: &str,
        limit: u32,
    ) -> rusqlite::Result<Vec<StoredMessage>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT m.body, m.deleted, f.message_id IS NOT NULL FROM messages m \
             LEFT JOIN first_messages f \
             ON f.channel_id = m.channel_id AND f.message_id = m.message_id \
             WHERE m.channel_id = ?1 AND m.user_id = ?2 \
             ORDER BY m.effective_ts DESC, m.arrival_seq DESC LIMIT ?3",
        )?;
        read_newest_first(&mut stmt, params![channel_id, user_id, limit])
    }

    /// One range seek on `messages_by_author`. The table is WITHOUT ROWID,
    /// so that index carries the primary key and `channel_id` comes from it
    /// without touching the table; only the author's own rows are grouped.
    fn sent_counts(&self, user_id: &str, since_ms: i64) -> rusqlite::Result<HashMap<String, u32>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT channel_id, COUNT(*) FROM messages \
             WHERE user_id = ?1 AND effective_ts >= ?2 GROUP BY channel_id",
        )?;
        let rows = stmt.query_map(params![user_id, since_ms], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?))
        })?;
        rows.collect()
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
        // Flags whose message is gone, from rows pruned in earlier runs.
        self.conn.execute(
            "DELETE FROM first_messages WHERE NOT EXISTS (\
             SELECT 1 FROM messages m WHERE m.channel_id = first_messages.channel_id \
             AND m.message_id = first_messages.message_id)",
            [],
        )?;
        Ok(())
    }
}

/// Decodes `(body, deleted)` rows selected newest first and returns them
/// oldest first.
fn read_newest_first(
    stmt: &mut rusqlite::CachedStatement<'_>,
    params: impl rusqlite::Params,
) -> rusqlite::Result<Vec<StoredMessage>> {
    let rows = stmt.query_map(params, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, bool>(1)?,
            r.get::<_, bool>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (body, deleted, first_message) = row?;
        // A row written by an older build with a different message
        // shape is skipped rather than failing the whole load.
        match serde_json::from_str(&body) {
            Ok(message) => out.push(StoredMessage {
                message,
                deleted,
                first_message,
            }),
            Err(e) => tracing::warn!(error = %e, "skipping unreadable history row"),
        }
    }
    out.reverse();
    Ok(out)
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
        query_op(channel, Query::Tail)
    }

    fn query_op(channel: &str, query: Query) -> (Op, oneshot::Receiver<Vec<StoredMessage>>) {
        let (reply, rx) = oneshot::channel();
        (
            Op::Load {
                channel_id: channel.into(),
                query,
                limit: 10,
                reply,
            },
            rx,
        )
    }

    #[test]
    fn user_load_returns_their_newest_rows_in_the_channel() {
        let mut s = store();
        s.store(&[
            msg("a", "c", "u1", 1, 0),
            msg("b", "c", "u2", 2, 1),
            msg("c", "c", "u1", 3, 2),
            msg("d", "c", "u1", 3, 3),
            msg("x", "other", "u1", 4, 4),
        ])
        .unwrap();
        s.apply(&[ChatEvent::MessageDeleted {
            channel_id: "c".into(),
            message_id: "d".into(),
            target_user_id: "u1".into(),
        }])
        .unwrap();
        let rows = s.load_user("c", "u1", 2).unwrap();
        assert_eq!(ids(&rows), ["c", "d"]);
        assert_eq!(
            rows.iter().map(|r| r.deleted).collect::<Vec<_>>(),
            [false, true]
        );
        assert!(s.load_user("c", "nobody", 10).unwrap().is_empty());
    }

    #[test]
    fn user_load_seeks_the_user_index() {
        let s = store();
        let plan: Vec<String> = s
            .conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT body, deleted FROM messages \
                 WHERE channel_id = ?1 AND user_id = ?2 \
                 ORDER BY effective_ts DESC, arrival_seq DESC LIMIT ?3",
            )
            .unwrap()
            .query_map(params!["c", "u", 10], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            plan.iter()
                .any(|d| d.contains("INDEX messages_by_user_time"))
                && !plan.iter().any(|d| d.contains("TEMP B-TREE")),
            "{plan:?}"
        );
    }

    #[test]
    fn schema_swaps_the_old_user_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch("CREATE INDEX messages_by_user ON messages (channel_id, user_id)")
            .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'messages_by_user%'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(names, ["messages_by_user_time"]);
    }

    #[test]
    fn user_load_waits_for_a_pending_import() {
        let mut s = store();
        s.handle(Op::ImportBegin("c".into()));
        let (load, mut rx) = query_op("c", Query::User("u".into()));
        s.handle(load);
        assert!(rx.try_recv().is_err());
        s.handle(Op::Import {
            channel_id: "c".into(),
            rows: vec![
                StoredMessage {
                    message: msg("mine", "c", "u", 1, 0),
                    deleted: false,
                    first_message: false,
                },
                StoredMessage {
                    message: msg("theirs", "c", "v", 2, 1),
                    deleted: false,
                    first_message: false,
                },
            ],
        });
        assert_eq!(ids(&rx.try_recv().unwrap()), ["mine"]);
    }

    #[tokio::test]
    async fn user_load_goes_through_the_history_thread() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::open(dir.path()).unwrap();
        history.store(&[msg("a", "c", "u", 1, 0), msg("b", "c", "v", 2, 1)]);
        let rows = history.load_user("c".into(), "u".into(), 10).await;
        assert_eq!(ids(&rows), ["a"]);
        history.close().await.unwrap();
        assert!(History::default()
            .load_user("c".into(), "u".into(), 10)
            .await
            .is_empty());
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
                first_message: false,
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
                first_message: false,
            },
            StoredMessage {
                message: msg("z", "c", "u", 0, 0),
                deleted: false,
                first_message: false,
            },
        ])
        .unwrap();
        let rows = s.load("c", 10).unwrap();
        assert_eq!(ids(&rows), ["z", "a", "b"]);
        assert!(rows[1].deleted);
        assert_eq!(rows[1].message.message_text, "hello a");
    }

    #[test]
    fn first_flags_survive_a_reload() {
        let mut s = store();
        // The flag can land before the message row is written.
        s.handle(Op::MarkFirst {
            channel_id: "c".into(),
            message_id: "a".into(),
        });
        s.store(&[msg("a", "c", "u", 1, 0), msg("b", "c", "u", 2, 1)])
            .unwrap();
        s.import(&[StoredMessage {
            message: msg("z", "c", "v", 0, 0),
            deleted: false,
            first_message: true,
        }])
        .unwrap();
        let flags: Vec<_> = s
            .load("c", 10)
            .unwrap()
            .iter()
            .map(|r| (r.message.id.clone(), r.first_message))
            .collect();
        assert_eq!(
            flags,
            [
                ("z".to_string(), true),
                ("a".to_string(), true),
                ("b".to_string(), false)
            ]
        );
    }

    #[test]
    fn user_load_keeps_first_flags() {
        let mut s = store();
        s.handle(Op::MarkFirst {
            channel_id: "c".into(),
            message_id: "a".into(),
        });
        s.store(&[msg("a", "c", "u", 1, 0), msg("b", "c", "u", 2, 1)])
            .unwrap();
        let flags: Vec<_> = s
            .load_user("c", "u", 10)
            .unwrap()
            .iter()
            .map(|r| (r.message.id.clone(), r.first_message))
            .collect();
        assert_eq!(flags, [("a".to_string(), true), ("b".to_string(), false)]);
    }

    #[test]
    fn age_prune_drops_flags_of_pruned_rows() {
        let mut s = store();
        let now = 1_000_000_000_000;
        let keep = i64::try_from(KEEP_FOR.as_millis()).unwrap();
        s.store(&[msg("old", "c", "u", now - keep - 1, 0)]).unwrap();
        s.handle(Op::MarkFirst {
            channel_id: "c".into(),
            message_id: "old".into(),
        });
        s.prune_old(now).unwrap();
        let left: i64 = s
            .conn
            .query_row("SELECT COUNT(*) FROM first_messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn close_releases_the_files_and_quiets_every_handle() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::open(dir.path()).unwrap();
        let other = history.clone();
        history.store(&[msg("a", "c", "u", 1, 0)]);
        assert_eq!(ids(&history.load("c".into(), 10).await), ["a"]);
        assert_eq!(history.sent_counts("u".into(), 0).await["c"], 1);

        history.close().await.unwrap();
        std::fs::remove_dir_all(dir.path()).unwrap();

        other.store(&[msg("b", "c", "u", 2, 1)]);
        assert!(other.load("c".into(), 10).await.is_empty());
        assert!(other.sent_counts("u".into(), 0).await.is_empty());
        other.close().await.unwrap();
        assert!(!dir.path().exists());
    }

    #[tokio::test]
    async fn closing_a_store_that_never_opened_is_fine() {
        History::default().close().await.unwrap();
    }

    #[test]
    fn sent_counts_tallies_the_author_per_channel_since_the_cutoff() {
        let mut s = store();
        s.store(&[
            msg("a", "c1", "me", 10, 0),
            msg("b", "c1", "me", 20, 1),
            msg("c", "c1", "them", 20, 2),
            msg("d", "c2", "me", 30, 3),
            msg("old", "c3", "me", 5, 4),
        ])
        .unwrap();
        let (reply, mut rx) = oneshot::channel();
        s.handle(Op::SentCounts {
            user_id: "me".into(),
            since_ms: 10,
            reply,
        });
        let counts = rx.try_recv().unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts["c1"], 2);
        assert_eq!(counts["c2"], 1);
    }

    #[test]
    fn sent_counts_seeks_the_author_index() {
        let s = store();
        let plan: Vec<String> = s
            .conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT channel_id, COUNT(*) FROM messages \
                 WHERE user_id = ?1 AND effective_ts >= ?2 GROUP BY channel_id",
            )
            .unwrap()
            .query_map(params!["me", 0], |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            plan.iter()
                .any(|d| d.contains("COVERING INDEX messages_by_author")),
            "{plan:?}"
        );
    }

    #[tokio::test]
    async fn sent_counts_without_a_store_is_empty() {
        assert!(History::default()
            .sent_counts("me".into(), 0)
            .await
            .is_empty());
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
