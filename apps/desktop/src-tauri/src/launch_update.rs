//! The window prismoid starts in, the way Discord starts: a small update
//! screen that looks for an update before the app shows and installs it
//! when there is one (the frontend drives the updater). The main window
//! stays hidden until the startup window hands over, and the app then skips
//! its own launch check.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "launch-update";

/// Whether this start went through the startup window.
#[derive(Default)]
pub struct LaunchCheck(AtomicBool);

/// Opens the startup window; the main window waits for `launch_update_done`.
pub fn start<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Starting prismoid")
        .inner_size(340.0, 230.0)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .center()
        .visible(false)
        // The main window's origin and switches, so it reads the same theme
        // and shares its WebView2 environment.
        .use_https_scheme(true)
        .additional_browser_args(crate::browser_args::BROWSER_ARGS)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
            }
        })
        .build()?;
    app.state::<LaunchCheck>().0.store(true, Ordering::Relaxed);
    Ok(())
}

/// The startup window found nothing to install, or gave up: show the app.
#[tauri::command]
pub fn launch_update_done<R: Runtime>(app: AppHandle<R>) {
    crate::tray::show_main(&app);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn launch_update_ran(state: State<'_, LaunchCheck>) -> bool {
    state.0.load(Ordering::Relaxed)
}
