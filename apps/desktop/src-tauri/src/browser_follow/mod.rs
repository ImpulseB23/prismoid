//! Follows the Twitch channel open in the front browser window. The address
//! bar is read through Windows UI Automation, the accessibility API screen
//! readers and time trackers use, so every browser works without an
//! extension. Only the front window's visible tab can be seen, and only
//! while the browser itself is not fullscreen.
//!
//! Background tabs only expose their titles, so which Twitch channels are
//! still open in a tab somewhere is read from the tab strips' titles
//! ("Caedrel - Twitch"), letting a preview stay while its tab does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::twitch_channel::normalize_login;

/// Event sent to the webview when the front browser shows a new channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrowserStream {
    pub platform: &'static str,
    pub login: String,
}

/// Event sent when the set of Twitch channels open in browser tabs changes.
/// `names` are lowercased title names (display names or logins);
/// `complete` is false when some browser window could not be read (it is
/// minimized), so a missing name proves nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrowserTabs {
    pub names: Vec<String>,
    pub complete: bool,
}

/// The channel name in a Twitch tab's title, lowercased: "Caedrel - Twitch",
/// with any "(3) " unread count in front or "- Audio playing" after.
pub fn twitch_tab_name(title: &str) -> Option<String> {
    let mut rest = title.trim_start();
    if let Some(after) = rest.strip_prefix('(') {
        if let Some((count, tail)) = after.split_once(") ") {
            if !count.is_empty() && count.chars().all(|c| c.is_ascii_digit()) {
                rest = tail;
            }
        }
    }
    let (name, tail) = rest.split_once(" - Twitch")?;
    // Browsers append their own notes (" – Audio playing"); anything else
    // after "Twitch" is some other site's title.
    if !(tail.is_empty() || [" -", " –", " —"].iter().any(|s| tail.starts_with(s))) {
        return None;
    }
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// On/off switch shared with the poller thread. Lives in Tauri state so the
/// Settings toggle can flip it; the poller sleeps while it is off.
#[derive(Default, Clone)]
pub struct BrowserFollow {
    enabled: Arc<AtomicBool>,
}

impl BrowserFollow {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

#[tauri::command]
pub fn set_browser_follow(state: State<'_, BrowserFollow>, enabled: bool) {
    state.enabled.store(enabled, Ordering::Relaxed);
}

/// First path segments on twitch.tv that are pages, not channels.
const RESERVED_PATHS: &[&str] = &[
    "directory",
    "videos",
    "settings",
    "downloads",
    "p",
    "search",
    "u",
    "drops",
    "jobs",
    "turbo",
    "friends",
    "subscriptions",
    "inventory",
    "wallet",
    "store",
    "prime",
    "login",
    "signup",
    "bits",
    "bits-checkout",
    "clips",
    "team",
    "collections",
    "event",
    "products",
    "payments",
    "dashboard",
    "broadcast",
    "following",
    "messages",
    "privacy",
    "security",
    "creatorcamp",
    "partner",
    "legal",
    "user",
    "activate",
    "redeem",
    "gift",
];

/// Channel login from a twitch.tv page address, as the address bar shows
/// it (browsers drop the scheme and `www.`). Popout chat, embed and mod
/// view addresses resolve to their channel; everything else on twitch.tv
/// is not a channel.
pub fn twitch_login_from_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let (host, path) = s.split_once('/').unwrap_or((s, ""));
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host != "twitch.tv" && host != "m.twitch.tv" {
        return None;
    }
    let mut segments = path
        .split(['/', '?', '#'])
        .filter(|segment| !segment.is_empty());
    let first = segments.next()?;
    let login = match first {
        "popout" | "moderator" | "embed" => segments.next()?,
        _ => first,
    };
    if RESERVED_PATHS.contains(&login) {
        return None;
    }
    normalize_login(login)
}

#[cfg(windows)]
pub fn spawn<R: tauri::Runtime>(app: tauri::AppHandle<R>, follow: BrowserFollow) {
    if let Err(e) = std::thread::Builder::new()
        .name("browser-follow".into())
        .spawn(move || win::run(app, follow))
    {
        tracing::error!(error = %e, "browser follow thread failed to start");
    }
}

#[cfg(windows)]
mod win;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_pages_resolve_to_their_login() {
        assert_eq!(twitch_login_from_url("twitch.tv/xqc"), Some("xqc".into()));
        assert_eq!(
            twitch_login_from_url("https://www.twitch.tv/Forsen?referrer=raid"),
            Some("forsen".into())
        );
        assert_eq!(
            twitch_login_from_url("m.twitch.tv/lirik/"),
            Some("lirik".into())
        );
        assert_eq!(
            twitch_login_from_url("twitch.tv/popout/xqc/chat?popout="),
            Some("xqc".into())
        );
        assert_eq!(
            twitch_login_from_url("www.twitch.tv/moderator/xqc"),
            Some("xqc".into())
        );
        assert_eq!(
            twitch_login_from_url("twitch.tv/xqc/clip/SomeClip"),
            Some("xqc".into())
        );
    }

    #[test]
    fn twitch_tab_titles_give_the_channel_name() {
        assert_eq!(
            twitch_tab_name("lolyoung - Twitch – Audio playing - High memory usage - 921 MB"),
            Some("lolyoung".into())
        );
        assert_eq!(
            twitch_tab_name("(3) Caedrel - Twitch"),
            Some("caedrel".into())
        );
        assert_eq!(twitch_tab_name("가나다 - Twitch"), Some("가나다".into()));
        for title in [
            "Twitch",
            "Just Chatting - Twitch Tracker",
            " - Twitch",
            "YouTube",
        ] {
            assert_eq!(twitch_tab_name(title), None, "{title}");
        }
    }

    #[test]
    fn other_pages_are_ignored() {
        for url in [
            "twitch.tv",
            "twitch.tv/",
            "twitch.tv/directory/category/just-chatting",
            "twitch.tv/videos/123456",
            "twitch.tv/settings/profile",
            "twitch.tv/popout",
            "clips.twitch.tv/SomeClip",
            "dashboard.twitch.tv/u/xqc/stream-manager",
            "youtube.com/watch?v=abc",
            "google.com/search?q=twitch.tv/xqc",
            "twitch.tv/has space",
        ] {
            assert_eq!(twitch_login_from_url(url), None, "{url}");
        }
    }
}
