//! Pop-out stream players: one window per channel, labelled by its login,
//! that the user can resize, move to another display and fullscreen. The
//! window loads the app's own page, which shows Twitch's embedded player
//! under the app's own title bar; its capability allows window controls,
//! the pop-back-in message and logging. The main window hears when one
//! closes, so a channel never plays in two places.

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::browser_args::BROWSER_ARGS;

/// Sent with the login when a pop-out closes.
pub const CLOSED_EVENT: &str = "video_window_closed";

const LABEL_PREFIX: &str = "video-";

/// The page's own title bar above the player, in CSS pixels.
const BAR_HEIGHT: f64 = 34.0;
/// Twitch's smallest allowed player, 400x300, widened to 16:9.
const MIN_PLAYER: (f64, f64) = (534.0, 300.0);

/// Twitch logins are 1 to 25 lowercase letters, digits and underscores,
/// which are also safe in a window label.
fn label_for(login: &str) -> Option<String> {
    let valid = (1..=25).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    valid.then(|| format!("{LABEL_PREFIX}{login}"))
}

/// Opens `login`'s player, or brings its open one forward. Async because
/// building a window in a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn video_window_open<R: Runtime>(
    app: AppHandle<R>,
    login: String,
    title: String,
) -> Result<(), String> {
    let label = label_for(&login).ok_or("not a twitch login")?;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        // A 16:9 player under the bar, so the stream fills it edge to edge.
        .inner_size(960.0, 540.0 + BAR_HEIGHT)
        .min_inner_size(MIN_PLAYER.0, MIN_PLAYER.1 + BAR_HEIGHT)
        .additional_browser_args(BROWSER_ARGS)
        // Twitch only lets its player run under an https parent.
        .use_https_scheme(true);
    // The page draws its own title bar on Windows, like the main window.
    #[cfg(windows)]
    let builder = builder.decorations(false);
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        // Tauri and this crate use different `windows` versions; the handle
        // is the same raw pointer in both, carried as an address because a
        // pointer cannot cross threads.
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        // Windows only lets the thread that owns a window subclass it, and
        // commands run on the async pool.
        app.run_on_main_thread(move || {
            let hwnd = windows::Win32::Foundation::HWND(hwnd as *mut std::ffi::c_void);
            if let Err(e) = aspect::lock(hwnd, BAR_HEIGHT) {
                tracing::error!(error = %e, "pop-out aspect lock failed");
            }
        })
        .map_err(|e| e.to_string())?;
    }
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = handle.emit(CLOSED_EVENT, &login);
        }
    });
    Ok(())
}

/// Closes every pop-out player, for when stream video is switched off.
#[tauri::command]
pub async fn video_windows_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            window.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Keeps a pop-out's player at 16:9 while its edges are dragged, the way
/// video players do: Windows asks before each step of a resize
/// (`WM_SIZING`) and the rectangle is adjusted then, so it never snaps back
/// afterwards and the stream never gets black bars.
#[cfg(windows)]
mod aspect {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowRect, WMSZ_BOTTOM, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
        WM_NCDESTROY, WM_SIZING,
    };

    const SUBCLASS_ID: usize = 1;

    /// `bar` is the height above the player in CSS pixels, scaled by the
    /// window's DPI on each resize.
    pub fn lock(hwnd: HWND, bar: f64) -> windows::core::Result<()> {
        // SAFETY: `hwnd` is the live window Tauri just built, and the
        // subclass removes itself when the window is destroyed.
        unsafe { SetWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID, bar.to_bits() as usize) }
            .ok()
    }

    unsafe extern "system" fn on_message(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        match msg {
            WM_SIZING => {
                // The window's own handling runs first; the shape is ours.
                DefSubclassProc(hwnd, msg, wparam, lparam);
                let (mut window, mut client) = (RECT::default(), RECT::default());
                if GetWindowRect(hwnd, &mut window).is_ok()
                    && GetClientRect(hwnd, &mut client).is_ok()
                {
                    let frame = (
                        (window.right - window.left) - (client.right - client.left),
                        (window.bottom - window.top) - (client.bottom - client.top),
                    );
                    let scale = f64::from(GetDpiForWindow(hwnd)) / 96.0;
                    let bar = (f64::from_bits(data as u64) * scale).round() as i32;
                    // SAFETY: for WM_SIZING, lparam points at the RECT Windows
                    // is about to apply, writable until this returns.
                    fit(wparam.0 as u32, &mut *(lparam.0 as *mut RECT), frame, bar);
                }
                LRESULT(1)
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(on_message), id);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    /// Reshapes `rect` so the player under `bar` is 16:9. Dragging the top
    /// or bottom edge sets the height and the width follows; any other edge
    /// or corner sets the width and the height follows, growing away from
    /// the edge being dragged. `frame` is the window's size minus its
    /// client area.
    pub(super) fn fit(edge: u32, rect: &mut RECT, frame: (i32, i32), bar: i32) {
        let width = rect.right - rect.left - frame.0;
        let height = rect.bottom - rect.top - frame.1;
        if edge == WMSZ_TOP || edge == WMSZ_BOTTOM {
            let player = (height - bar).max(1);
            rect.right = rect.left + (player * 16 + 4) / 9 + frame.0;
        } else {
            let total = (width * 9 + 8) / 16 + bar + frame.1;
            if edge == WMSZ_TOP || edge == WMSZ_TOPLEFT || edge == WMSZ_TOPRIGHT {
                rect.top = rect.bottom - total;
            } else {
                rect.bottom = rect.top + total;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resizing_keeps_the_player_16_9() {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{
            WMSZ_BOTTOMRIGHT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT,
        };

        let player = |r: &RECT, frame: (i32, i32), bar: i32| {
            (r.right - r.left - frame.0, r.bottom - r.top - frame.1 - bar)
        };
        let frame = (16, 9);

        let mut r = RECT {
            left: 100,
            top: 100,
            right: 100 + 1280 + 16,
            bottom: 300,
        };
        aspect::fit(WMSZ_RIGHT, &mut r, frame, 34);
        assert_eq!(player(&r, frame, 34), (1280, 720));
        assert_eq!(r.top, 100);

        let mut r = RECT {
            left: 0,
            top: 0,
            right: 10,
            bottom: 360 + 34 + 9,
        };
        aspect::fit(WMSZ_TOP, &mut r, frame, 34);
        assert_eq!(player(&r, frame, 34), (640, 360));

        // Dragging a top corner grows upward and keeps the bottom where it is.
        let mut r = RECT {
            left: 0,
            top: 50,
            right: 1920,
            bottom: 1200,
        };
        aspect::fit(WMSZ_TOPLEFT, &mut r, (0, 0), 51);
        assert_eq!(player(&r, (0, 0), 51), (1920, 1080));
        assert_eq!(r.bottom, 1200);

        let mut r = RECT {
            left: 0,
            top: 0,
            right: 1000,
            bottom: 10,
        };
        aspect::fit(WMSZ_BOTTOMRIGHT, &mut r, (0, 0), 0);
        assert_eq!(player(&r, (0, 0), 0), (1000, 563));
    }

    #[test]
    fn labels_only_real_logins() {
        assert_eq!(label_for("caedrel").as_deref(), Some("video-caedrel"));
        assert_eq!(label_for("a_b_9").as_deref(), Some("video-a_b_9"));
        for bad in ["", "Caps", "has space", "../x", "a".repeat(26).as_str()] {
            assert_eq!(label_for(bad), None, "{bad}");
        }
    }
}
