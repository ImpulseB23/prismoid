//! Tauri surface for the storage move: the real [`Host`], the hidden
//! window, and thin `#[tauri::command]` adapters over the logic in
//! `mod.rs`, which is unit-tested there. Excluded from coverage in
//! `codecov.yml` because exercising it needs a Tauri runtime and WebView2.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

use super::{finish_on, import_on, pending, Entries, Host, StorageMove, LABEL, WAIT};

struct App<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Host for App<R> {
    fn data_dir(&self) -> Result<PathBuf, String> {
        self.0.path().app_data_dir().map_err(|e| e.to_string())
    }

    fn dev(&self) -> bool {
        tauri::is_dev()
    }

    fn close_window(&self) {
        if let Some(window) = self.0.get_webview_window(LABEL) {
            let _ = window.close();
        }
    }
}

/// Opens the hidden window on the old origin when a move may be needed.
pub fn start<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if !pending(&App(app.clone())) {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .visible(false)
        .use_https_scheme(false)
        .additional_browser_args(crate::browser_args::BROWSER_ARGS)
        .build()?;
    Ok(())
}

/// Main window, before it renders: the old origin's entries, or `None` when
/// there is nothing to move.
#[tauri::command]
pub async fn storage_move_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, StorageMove>,
) -> Result<Option<Entries>, String> {
    import_on(&App(app), &state).await
}

/// Main window, after writing the entries.
#[tauri::command]
pub fn storage_move_imported(state: State<'_, StorageMove>) {
    state.imported.send_replace(true);
}

/// Hidden window: sends its entries and learns whether the main window kept
/// them, which is when it may clear them.
#[tauri::command]
pub async fn storage_move_export(
    state: State<'_, StorageMove>,
    entries: Entries,
) -> Result<bool, String> {
    Ok(state.hand_over(entries, WAIT).await)
}

/// Hidden window, last: records the move once the old origin is empty.
#[tauri::command]
pub fn storage_move_finish<R: Runtime>(app: AppHandle<R>, cleared: bool) -> Result<(), String> {
    finish_on(&App(app), cleared)
}
