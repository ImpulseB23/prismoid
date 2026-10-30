//! Switches for the EventSub feeds behind features the user can turn off:
//! moderation (channel.moderate and the AutoMod queue) and the stream
//! manager's polls, predictions and ad breaks. While one is off the
//! sidecar deletes its subscriptions and makes no new ones.

use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::host::build_twitch_feed_line;
use crate::sidecar_commands::SidecarCommandSender;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TwitchFeed {
    Moderation,
    Broadcaster,
}

/// Both on by default, matching the frontend settings. Locked across each
/// write so a toggle racing a sidecar start cannot reach it out of order.
#[derive(Clone)]
pub struct TwitchFeedSetting {
    on: Arc<Mutex<Feeds>>,
}

#[derive(Clone, Copy)]
struct Feeds {
    moderation: bool,
    broadcaster: bool,
}

impl Default for TwitchFeedSetting {
    fn default() -> Self {
        Self {
            on: Arc::new(Mutex::new(Feeds {
                moderation: true,
                broadcaster: true,
            })),
        }
    }
}

impl TwitchFeedSetting {
    /// Sends both values; the supervisor calls this after each spawn.
    pub fn sync(&self, mut write: impl FnMut(&[u8]) -> bool) {
        let on = self.on.lock().unwrap_or_else(PoisonError::into_inner);
        send(TwitchFeed::Moderation, on.moderation, &mut write);
        send(TwitchFeed::Broadcaster, on.broadcaster, &mut write);
    }

    fn set(&self, feed: TwitchFeed, enabled: bool, mut write: impl FnMut(&[u8]) -> bool) {
        let mut on = self.on.lock().unwrap_or_else(PoisonError::into_inner);
        match feed {
            TwitchFeed::Moderation => on.moderation = enabled,
            TwitchFeed::Broadcaster => on.broadcaster = enabled,
        }
        send(feed, enabled, &mut write);
    }
}

fn send(feed: TwitchFeed, enabled: bool, write: &mut impl FnMut(&[u8]) -> bool) {
    match build_twitch_feed_line(feed, enabled) {
        // A failed write means no sidecar is up; the next one gets the
        // value at spawn.
        Ok(line) => {
            write(&line);
        }
        Err(e) => tracing::error!(error = %e, "failed to serialize twitch_feed"),
    }
}

#[tauri::command]
pub fn set_twitch_feed(
    state: State<'_, TwitchFeedSetting>,
    sender: State<'_, SidecarCommandSender>,
    feed: TwitchFeed,
    enabled: bool,
) {
    state.set(feed, enabled, |line| sender.write_raw(line));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synced(setting: &TwitchFeedSetting) -> Vec<serde_json::Value> {
        let mut lines = Vec::new();
        setting.sync(|l| {
            lines.push(serde_json::from_slice(l).unwrap());
            true
        });
        lines
    }

    #[test]
    fn sync_sends_both_stored_values() {
        let setting = TwitchFeedSetting::default();
        let lines = synced(&setting);
        assert_eq!(lines.len(), 2);
        assert!(lines
            .iter()
            .all(|v| v["cmd"] == "twitch_feed" && v["enabled"] == true));
        assert_eq!(lines[0]["feed"], "moderation");
        assert_eq!(lines[1]["feed"], "broadcaster");

        let mut sent = Vec::new();
        setting.set(TwitchFeed::Broadcaster, false, |l| {
            sent.push(serde_json::from_slice::<serde_json::Value>(l).unwrap());
            true
        });
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["feed"], "broadcaster");
        assert_eq!(sent[0]["enabled"], false);
        let lines = synced(&setting);
        assert_eq!(lines[0]["enabled"], true);
        assert_eq!(lines[1]["enabled"], false);
    }

    #[test]
    fn set_keeps_the_value_when_no_sidecar_runs() {
        let setting = TwitchFeedSetting::default();
        setting.set(TwitchFeed::Moderation, false, |_| false);
        assert_eq!(synced(&setting)[0]["enabled"], false);
    }

    #[test]
    fn feeds_parse_from_the_frontend() {
        let feed: TwitchFeed = serde_json::from_str("\"broadcaster\"").unwrap();
        assert_eq!(feed, TwitchFeed::Broadcaster);
        assert!(serde_json::from_str::<TwitchFeed>("\"chat\"").is_err());
    }
}
