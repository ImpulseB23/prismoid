//! Settings reset and full data reset. Most preferences live in the
//! webview's localStorage and the frontend clears those itself; the ones
//! here are what the host keeps on disk or in the OS: the sign-in autostart
//! entry and the window geometry the window-state plugin saves. The
//! in-memory switches (browser follow, backlog, close to tray, first
//! messages, paints) are pushed by the frontend settings store and follow
//! it when it resets.

use std::io;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, LogicalSize, Manager, Runtime};
use tauri_plugin_window_state::AppHandleExt;

use crate::chat_history::History;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ResetError {
    pub kind: &'static str,
    pub message: String,
}

impl ResetError {
    fn new(kind: &'static str, err: impl std::fmt::Display) -> Self {
        Self {
            kind,
            message: err.to_string(),
        }
    }
}

#[tauri::command]
pub async fn reset_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), ResetError> {
    reset_host_settings(&app)
}

/// Signs out of every platform, deletes the chat history and everything
/// else in the app data directory, then resets settings. The frontend
/// clears localStorage and relaunches afterwards. Logs and the WebView2
/// profile stay: the logs are what a later bug report needs, and the
/// profile is in use by the running webview.
#[tauri::command]
pub async fn reset_all_data<R: Runtime>(app: AppHandle<R>) -> Result<(), ResetError> {
    if let Some(twitch) = app.try_state::<crate::twitch_auth::AuthState>() {
        twitch
            .logout()
            .await
            .map_err(|e| ResetError::new("sign_out", e.message))?;
    }
    if let Some(youtube) = app.try_state::<crate::youtube_auth::AuthState>() {
        youtube
            .logout()
            .await
            .map_err(|e| ResetError::new("sign_out", e.message))?;
    }
    if let Some(history) = app.try_state::<History>() {
        history.close().await;
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| ResetError::new("files", e))?;
    remove_dir(&dir).map_err(|e| ResetError::new("files", e))?;
    reset_host_settings(&app)
}

fn reset_host_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), ResetError> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .disable()
            .map_err(|e| ResetError::new("autostart", e))?;
    }
    reset_window(app).map_err(|e| ResetError::new("window", e))?;
    // The plugin saves again on exit, from the window as it is then, so the
    // geometry has to be reset on the window itself, not only on disk.
    app.save_window_state(crate::WINDOW_STATE)
        .map_err(|e| ResetError::new("window", e))
}

/// Puts the main window back to the size in the app config, centered.
fn reset_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.set_fullscreen(false)?;
    window.unmaximize()?;
    if let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main") {
        window.set_size(LogicalSize::new(config.width, config.height))?;
    }
    window.center()
}

fn remove_dir(dir: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_dir_deletes_contents_and_tolerates_absence() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("org.prismoid.app");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chat.sqlite3"), b"x").unwrap();
        std::fs::write(dir.join(".window-state.json"), b"{}").unwrap();

        remove_dir(&dir).unwrap();
        assert!(!dir.exists());
        remove_dir(&dir).unwrap();
    }

    #[test]
    fn error_serializes_as_kind_and_message() {
        let err = ResetError::new("files", "access denied");
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            serde_json::json!({ "kind": "files", "message": "access denied" })
        );
    }
}
