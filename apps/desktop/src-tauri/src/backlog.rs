//! Earlier messages for a channel the app has not logged itself, from the
//! recent-messages service (<https://recent-messages.robotty.de/>) that
//! Chatterino and DankChat also use. Twitch sends nothing from before the
//! join, so this is the only source for a first open. The service returns
//! raw Twitch IRC lines; they go through the shared IRC parser and into the
//! history store, whose load merges them with anything the app logged on
//! its own.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::State;
use tokio::sync::watch;

use crate::chat_history::{History, StoredMessage};
use crate::emote_index::EmoteIndexes;
use crate::sidecar_supervisor::BundleArrival;
use crate::twitch_channel::Channel;
use crate::twitch_irc::{parse_line, IrcItem};

pub const SERVICE_URL: &str = "https://recent-messages.robotty.de";
/// Lines asked for per join. The service asks clients to stay modest.
const LIMIT: u32 = 400;
const FETCH_TIMEOUT: Duration = Duration::from_secs(4);
/// How long to wait for the channel's emote bundle before scanning the
/// lines, so channel emotes resolve the way they do for live messages.
const BUNDLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether joins fetch a backlog. On by default; the settings page carries
/// the opt-out and a link to the service, as its terms ask.
#[derive(Clone)]
pub struct BacklogSetting {
    enabled: Arc<AtomicBool>,
}

impl Default for BacklogSetting {
    fn default() -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl BacklogSetting {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn set_chat_backlog(state: State<'_, BacklogSetting>, enabled: bool) {
    state.enabled.store(enabled, Ordering::Relaxed);
}

#[derive(Debug, Deserialize)]
struct Response {
    #[serde(default)]
    messages: Vec<String>,
    #[serde(default)]
    error_code: Option<String>,
}

/// Fetches, maps and stores the backlog for `channel`. The caller has
/// already told the store an import is coming, so this always reports one,
/// empty on any failure, which releases the loads waiting on it.
pub async fn import(
    http: reqwest::Client,
    channel: Channel,
    history: History,
    emote_index: Arc<EmoteIndexes>,
    mut bundle: watch::Receiver<BundleArrival>,
) {
    let guard = ImportGuard {
        history: &history,
        channel_id: &channel.id,
        done: false,
    };
    let (fetched, _) = tokio::join!(
        fetch(&http, SERVICE_URL, &channel.login),
        tokio::time::timeout(BUNDLE_TIMEOUT, wait_for_bundle(&mut bundle, &channel.id)),
    );
    let rows = match fetched {
        Ok(resp) => {
            if resp.error_code.as_deref() == Some("channel_not_joined") {
                tracing::info!(login = %channel.login, "backlog service was not in this channel yet; history may have gaps");
            }
            let mut rows = parse_lines(&resp.messages, &channel.id);
            if let Some(index) = emote_index.get(&channel.id) {
                for row in &mut rows {
                    index.scan_into(&row.message.message_text, &mut row.message.emote_spans);
                }
            }
            rows
        }
        Err(e) => {
            tracing::warn!(error = %e, login = %channel.login, "backlog fetch failed");
            Vec::new()
        }
    };
    tracing::debug!(login = %channel.login, rows = rows.len(), "backlog imported");
    guard.finish(rows);
}

async fn wait_for_bundle(rx: &mut watch::Receiver<BundleArrival>, channel_id: &str) {
    while rx.changed().await.is_ok() {
        if rx.borrow().1 == channel_id {
            return;
        }
    }
}

struct ImportGuard<'a> {
    history: &'a History,
    channel_id: &'a str,
    done: bool,
}

impl ImportGuard<'_> {
    fn finish(mut self, rows: Vec<StoredMessage>) {
        self.done = true;
        self.history.import(self.channel_id.to_owned(), rows);
    }
}

impl Drop for ImportGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.history.import(self.channel_id.to_owned(), Vec::new());
        }
    }
}

async fn fetch(http: &reqwest::Client, base: &str, login: &str) -> reqwest::Result<Response> {
    http.get(format!("{base}/api/v2/recent-messages/{login}"))
        .query(&[
            ("limit", LIMIT.to_string().as_str()),
            ("hide_moderation_messages", "true"),
        ])
        .timeout(FETCH_TIMEOUT)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

/// Maps the service's lines onto stored rows. Only chat rows are kept: the
/// request hides moderation lines and `rm-deleted` carries their effect.
/// The index in the response becomes `arrival_seq` so lines sharing a
/// timestamp keep their order.
pub fn parse_lines(lines: &[String], channel_id: &str) -> Vec<StoredMessage> {
    lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| match parse_line(line, Some(channel_id))? {
            IrcItem::Message {
                mut message,
                deleted,
            } => {
                message.arrival_seq = u64::try_from(i).expect("line index fits in u64");
                Some(StoredMessage {
                    message: *message,
                    deleted,
                })
            }
            IrcItem::Event(_) => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn rows_keep_response_order_and_skip_non_chat_lines() {
        let rows = parse_lines(
            &lines(&[
                "@room-id=1 :tmi.twitch.tv ROOMSTATE #c",
                "@id=a;rm-deleted=1;tmi-sent-ts=1;user-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #c :one",
                "@room-id=1;target-user-id=1;tmi-sent-ts=2 :tmi.twitch.tv CLEARCHAT #c :a",
                "@id=b;tmi-sent-ts=1;user-id=2 :b!b@b.tmi.twitch.tv PRIVMSG #c :two",
            ]),
            "1",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].message.id, "a");
        assert!(rows[0].deleted);
        assert_eq!(rows[0].message.arrival_seq, 1);
        assert_eq!(rows[0].message.channel_id, "1");
        assert_eq!(rows[1].message.id, "b");
        assert_eq!(rows[1].message.arrival_seq, 3);
    }

    #[tokio::test]
    async fn fetch_builds_the_documented_request() {
        let server = httpmock::MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(httpmock::Method::GET)
                .path("/api/v2/recent-messages/forsen")
                .query_param("limit", "400")
                .query_param("hide_moderation_messages", "true");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"messages":["@id=a;tmi-sent-ts=1;user-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #c :hi"],"error":null,"error_code":"channel_not_joined"}"#);
        });
        let resp = fetch(&reqwest::Client::new(), &server.base_url(), "forsen")
            .await
            .unwrap();
        mock.assert();
        assert_eq!(resp.messages.len(), 1);
        assert_eq!(resp.error_code.as_deref(), Some("channel_not_joined"));
    }

    #[tokio::test]
    async fn fetch_rejects_error_statuses() {
        let server = httpmock::MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(httpmock::Method::GET);
            then.status(403)
                .body(r#"{"status":403,"error_code":"channel_ignored"}"#);
        });
        assert!(fetch(&reqwest::Client::new(), &server.base_url(), "x")
            .await
            .is_err());
    }
}
