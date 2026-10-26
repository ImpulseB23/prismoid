//! Follows the Twitch channel open in the front browser window. The address
//! bar is read through Windows UI Automation, the accessibility API screen
//! readers and time trackers use, so every browser works without an
//! extension. Only the front window's visible tab can be seen, and only
//! while the browser itself is not fullscreen.

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
mod win {
    use std::collections::HashMap;
    use std::time::Duration;

    use tauri::{AppHandle, Emitter, Runtime};
    use windows::core::BSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_ValueValuePropertyId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    use super::{twitch_login_from_url, BrowserFollow, BrowserStream};

    const POLL: Duration = Duration::from_secs(1);
    /// Nodes of browser chrome visited at most while looking for the
    /// address bar; web content (Document subtrees) is never entered.
    const SEARCH_LIMIT: usize = 400;
    const SEARCH_DEPTH: usize = 12;
    const BROWSERS: &[&str] = &[
        "chrome",
        "msedge",
        "firefox",
        "brave",
        "opera",
        "opera_gx",
        "vivaldi",
        "chromium",
        "arc",
        "zen",
        "librewolf",
        "floorp",
        "waterfox",
        "thorium",
    ];

    pub fn run<R: Runtime>(app: AppHandle<R>, follow: BrowserFollow) {
        // SAFETY: plain COM initialisation on a thread we own for its whole life.
        if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
            tracing::error!(error = %e, "browser follow: COM init failed");
            return;
        }
        // SAFETY: standard in-process activation of the UIA client object.
        let uia: IUIAutomation =
            match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                Ok(u) => u,
                Err(e) => {
                    tracing::error!(error = %e, "browser follow: UI Automation unavailable");
                    return;
                }
            };
        let walker = match unsafe { uia.ControlViewWalker() } {
            Ok(w) => w,
            Err(e) => {
                tracing::error!(error = %e, "browser follow: tree walker unavailable");
                return;
            }
        };

        let mut address_bars: HashMap<isize, IUIAutomationElement> = HashMap::new();
        let mut last: Option<String> = None;
        loop {
            std::thread::sleep(POLL);
            if !follow.is_enabled() {
                last = None;
                continue;
            }
            let Some(login) = front_browser_url(&uia, &walker, &mut address_bars)
                .as_deref()
                .and_then(twitch_login_from_url)
            else {
                continue;
            };
            if last.as_deref() == Some(login.as_str()) {
                continue;
            }
            tracing::info!(login = %login, "browser shows a new channel");
            if let Err(e) = app.emit(
                "browser_stream",
                &BrowserStream {
                    platform: "twitch",
                    login: login.clone(),
                },
            ) {
                tracing::warn!(error = %e, "failed to emit browser_stream");
            }
            last = Some(login);
        }
    }

    /// Address bar text of the foreground window when it belongs to a known
    /// browser. The bar element is cached per window so a poll normally
    /// costs one property read.
    fn front_browser_url(
        uia: &IUIAutomation,
        walker: &IUIAutomationTreeWalker,
        cache: &mut HashMap<isize, IUIAutomationElement>,
    ) -> Option<String> {
        // SAFETY: GetForegroundWindow has no preconditions.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return None;
        }
        let key = hwnd.0 as isize;
        if let Some(bar) = cache.get(&key) {
            match value_of(bar) {
                Some(v) => return Some(v),
                None => {
                    cache.remove(&key);
                }
            }
        }
        if !is_browser(hwnd) {
            return None;
        }
        // SAFETY: hwnd came from the foreground query a moment ago; UIA
        // tolerates a window that closed in between by returning an error.
        let root = unsafe { uia.ElementFromHandle(hwnd) }.ok()?;
        let bar = find_address_bar(walker, &root)?;
        let value = value_of(&bar)?;
        cache.insert(key, bar);
        Some(value)
    }

    fn is_browser(hwnd: HWND) -> bool {
        let mut pid = 0u32;
        // SAFETY: pid is a valid out pointer for the call's duration.
        if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) } == 0 {
            return false;
        }
        // SAFETY: limited-information query handle, closed below.
        let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(h) => h,
            Err(_) => return false,
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: buf/len describe a writable buffer; len is updated in place.
        let ok = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        }
        .is_ok();
        // SAFETY: handle from OpenProcess above, closed exactly once.
        let _ = unsafe { CloseHandle(process) };
        if !ok {
            return false;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let stem = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        stem.is_some_and(|s| BROWSERS.contains(&s.as_str()))
    }

    /// Breadth-first walk of the browser's own controls for the Edit that
    /// holds an address. Document subtrees are web content and skipped, so
    /// the page's own text fields are never read.
    fn find_address_bar(
        walker: &IUIAutomationTreeWalker,
        root: &IUIAutomationElement,
    ) -> Option<IUIAutomationElement> {
        let mut frontier = vec![root.clone()];
        let mut visited = 0usize;
        for _ in 0..SEARCH_DEPTH {
            let mut next = Vec::new();
            for node in &frontier {
                // SAFETY: node is a live element; failures mean it vanished.
                let mut child = unsafe { walker.GetFirstChildElement(node) }.ok();
                while let Some(el) = child {
                    visited += 1;
                    if visited > SEARCH_LIMIT {
                        return None;
                    }
                    // SAFETY: as above.
                    let control = unsafe { el.CurrentControlType() }.ok();
                    if control == Some(UIA_EditControlTypeId) {
                        if value_of(&el).is_some_and(|v| v.contains('.')) {
                            return Some(el);
                        }
                    } else if control != Some(UIA_DocumentControlTypeId) {
                        next.push(el.clone());
                    }
                    // SAFETY: as above.
                    child = unsafe { walker.GetNextSiblingElement(&el) }.ok();
                }
            }
            if next.is_empty() {
                return None;
            }
            frontier = next;
        }
        None
    }

    fn value_of(el: &IUIAutomationElement) -> Option<String> {
        // SAFETY: property read on a live element; an error means it is gone.
        let v: VARIANT = unsafe { el.GetCurrentPropertyValue(UIA_ValueValuePropertyId) }.ok()?;
        let text = BSTR::try_from(&v).ok()?.to_string();
        (!text.is_empty()).then_some(text)
    }
}

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
