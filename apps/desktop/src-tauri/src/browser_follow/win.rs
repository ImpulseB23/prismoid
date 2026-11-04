//! The Windows side of browser follow: the UI Automation poller that reads
//! the front window's address bar and every browser's tab strip. It needs
//! real windows, so it is excluded from coverage in `codecov.yml`; what it
//! reads is turned into channels by the tested functions in `mod.rs`.

use std::collections::HashMap;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};
use windows::core::BOOL;
use windows::core::BSTR;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationTreeWalker, TreeScope_Descendants, UIA_ControlTypePropertyId,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_TabItemControlTypeId,
    UIA_ValueValuePropertyId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
};

use super::{twitch_login_from_url, twitch_tab_name, BrowserFollow, BrowserStream, BrowserTabs};

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

    // SAFETY: plain property condition on the control type.
    let tab_items = match unsafe {
        uia.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_TabItemControlTypeId.0),
        )
    } {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "browser follow: tab condition unavailable");
            return;
        }
    };

    let mut address_bars: HashMap<isize, IUIAutomationElement> = HashMap::new();
    let mut last: Option<String> = None;
    // A tab set is reported once two reads in a row agree, so a page
    // reload (its title briefly just "Twitch") never reads as a close.
    let mut seen: Option<BrowserTabs> = None;
    let mut sent: Option<BrowserTabs> = None;
    loop {
        std::thread::sleep(POLL);
        if !follow.is_enabled() {
            last = None;
            seen = None;
            sent = None;
            continue;
        }
        let tabs = open_twitch_tabs(&uia, &tab_items);
        if seen.as_ref() == Some(&tabs) && sent.as_ref() != Some(&tabs) {
            if let Err(e) = app.emit("browser_tabs", &tabs) {
                tracing::warn!(error = %e, "failed to emit browser_tabs");
            }
            sent = Some(tabs.clone());
        }
        seen = Some(tabs);
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

/// Twitch channel names in the tab strips of every visible browser
/// window. A minimized window's tabs cannot be read, which makes the
/// set incomplete.
fn open_twitch_tabs(uia: &IUIAutomation, tab_items: &IUIAutomationCondition) -> BrowserTabs {
    let mut windows: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into the Vec passed as lparam,
    // which outlives the synchronous EnumWindows call.
    let _ = unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM(&mut windows as *mut Vec<HWND> as isize),
        )
    };
    let mut names = Vec::new();
    let mut complete = true;
    for hwnd in windows {
        // SAFETY: hwnd came from EnumWindows; both calls tolerate a
        // window that has closed since.
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() || !is_browser(hwnd) {
            continue;
        }
        // SAFETY: as above.
        if unsafe { IsIconic(hwnd) }.as_bool() {
            complete = false;
            continue;
        }
        // SAFETY: as above; UIA returns an error for a vanished window.
        let Ok(root) = (unsafe { uia.ElementFromHandle(hwnd) }) else {
            continue;
        };
        // SAFETY: read-only search of the browser's own UI.
        let Ok(found) = (unsafe { root.FindAll(TreeScope_Descendants, tab_items) }) else {
            continue;
        };
        // SAFETY: reads on the array UIA just returned.
        let count = unsafe { found.Length() }.unwrap_or(0);
        for i in 0..count {
            // SAFETY: i is within the array's length.
            let Ok(tab) = (unsafe { found.GetElement(i) }) else {
                continue;
            };
            // SAFETY: property read on a live element.
            if let Ok(title) = unsafe { tab.CurrentName() } {
                if let Some(name) = twitch_tab_name(&title.to_string()) {
                    names.push(name);
                }
            }
        }
    }
    names.sort();
    names.dedup();
    BrowserTabs { names, complete }
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam is the &mut Vec<HWND> open_twitch_tabs passed in.
    let windows = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    windows.push(hwnd);
    true.into()
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
