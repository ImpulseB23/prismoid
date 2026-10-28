//! Settings reset and full data reset. Most preferences live in the
//! webview's localStorage and the frontend clears those itself; the ones
//! here are what the host keeps on disk or in the OS: the sign-in autostart
//! entry and the window geometry the window-state plugin saves. The
//! in-memory switches (browser follow, backlog, close to tray, first
//! messages, paints) are pushed by the frontend settings store and follow
//! it when it resets.

use std::io;
use std::path::{Path, PathBuf};

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
    reset_settings_on(&App(app))
}

/// Signs out of every platform, deletes the chat history and everything
/// else in the app data directory, then resets settings. The frontend
/// clears localStorage and relaunches afterwards. Logs and the WebView2
/// profile stay: the logs are what a later bug report needs, and the
/// profile is in use by the running webview.
#[tauri::command]
pub async fn reset_all_data<R: Runtime>(app: AppHandle<R>) -> Result<(), ResetError> {
    reset_all_on(&App(app)).await
}

/// What a reset changes outside the webview. [`App`] is the real one.
trait Host {
    async fn sign_out(&self) -> Result<(), String>;
    /// Must release the history files before [`Host::data_dir`] is deleted.
    async fn close_history(&self) -> Result<(), String>;
    fn data_dir(&self) -> Result<PathBuf, String>;
    fn disable_autostart(&self) -> Result<(), String>;
    fn reset_window(&self) -> Result<(), String>;
}

fn reset_settings_on(host: &impl Host) -> Result<(), ResetError> {
    host.disable_autostart()
        .map_err(|e| ResetError::new("autostart", e))?;
    host.reset_window()
        .map_err(|e| ResetError::new("window", e))
}

async fn reset_all_on(host: &impl Host) -> Result<(), ResetError> {
    host.sign_out()
        .await
        .map_err(|e| ResetError::new("sign_out", e))?;
    host.close_history()
        .await
        .map_err(|e| ResetError::new("files", e))?;
    let dir = host.data_dir().map_err(|e| ResetError::new("files", e))?;
    remove_dir(&dir).map_err(|e| ResetError::new("files", e))?;
    reset_settings_on(host)
}

fn remove_dir(dir: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

struct App<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Host for App<R> {
    async fn sign_out(&self) -> Result<(), String> {
        // Reuses the sign-out commands' paths; either may be missing when
        // its client failed to build at startup.
        if let Some(twitch) = self.0.try_state::<crate::twitch_auth::AuthState>() {
            twitch.logout().await.map_err(|e| e.message)?;
        }
        if let Some(youtube) = self.0.try_state::<crate::youtube_auth::AuthState>() {
            youtube.logout().await.map_err(|e| e.message)?;
        }
        Ok(())
    }

    async fn close_history(&self) -> Result<(), String> {
        match self.0.try_state::<History>() {
            Some(history) => history.close().await.map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    fn data_dir(&self) -> Result<PathBuf, String> {
        self.0.path().app_data_dir().map_err(|e| e.to_string())
    }

    fn disable_autostart(&self) -> Result<(), String> {
        #[cfg(desktop)]
        {
            use tauri_plugin_autostart::ManagerExt;
            self.0.autolaunch().disable().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// The plugin saves again on exit, from the window as it is then, so
    /// the geometry has to be reset on the window itself, not only on disk.
    fn reset_window(&self) -> Result<(), String> {
        reset_window(&self.0).map_err(|e| e.to_string())?;
        self.0
            .save_window_state(crate::WINDOW_STATE)
            .map_err(|e| e.to_string())
    }
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

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct Fake {
        dir: PathBuf,
        fail: Option<&'static str>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn new(dir: PathBuf, fail: Option<&'static str>) -> Self {
            Self {
                dir,
                fail,
                calls: RefCell::default(),
            }
        }

        fn step(&self, name: &'static str) -> Result<(), String> {
            self.calls.borrow_mut().push(name);
            match self.fail {
                Some(f) if f == name => Err(format!("{name} broke")),
                _ => Ok(()),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl Host for Fake {
        async fn sign_out(&self) -> Result<(), String> {
            self.step("sign_out")
        }
        async fn close_history(&self) -> Result<(), String> {
            self.step("close_history")
        }
        fn data_dir(&self) -> Result<PathBuf, String> {
            self.step("data_dir").map(|()| self.dir.clone())
        }
        fn disable_autostart(&self) -> Result<(), String> {
            self.step("disable_autostart")
        }
        fn reset_window(&self) -> Result<(), String> {
            self.step("reset_window")
        }
    }

    fn data_dir(root: &Path) -> PathBuf {
        let dir = root.join("org.prismoid.app");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("chat.sqlite3"), b"x").unwrap();
        std::fs::write(dir.join(".window-state.json"), b"{}").unwrap();
        dir
    }

    #[test]
    fn settings_reset_turns_off_autostart_and_resets_the_window() {
        let host = Fake::new(PathBuf::new(), None);
        reset_settings_on(&host).unwrap();
        assert_eq!(host.calls(), ["disable_autostart", "reset_window"]);
    }

    #[tokio::test]
    async fn full_reset_signs_out_and_releases_history_before_deleting() {
        let root = tempfile::tempdir().unwrap();
        let host = Fake::new(data_dir(root.path()), None);
        reset_all_on(&host).await.unwrap();
        assert_eq!(
            host.calls(),
            [
                "sign_out",
                "close_history",
                "data_dir",
                "disable_autostart",
                "reset_window"
            ]
        );
        assert!(!host.dir.exists());
    }

    #[tokio::test]
    async fn a_missing_data_dir_is_already_reset() {
        let root = tempfile::tempdir().unwrap();
        let host = Fake::new(root.path().join("never-created"), None);
        reset_all_on(&host).await.unwrap();
        assert_eq!(host.calls().len(), 5);
    }

    #[tokio::test]
    async fn a_failed_step_stops_the_reset_with_its_kind() {
        let cases = [
            ("sign_out", "sign_out", 1),
            ("close_history", "files", 2),
            ("data_dir", "files", 3),
            ("disable_autostart", "autostart", 4),
            ("reset_window", "window", 5),
        ];
        for (step, kind, ran) in cases {
            let root = tempfile::tempdir().unwrap();
            let host = Fake::new(data_dir(root.path()), Some(step));
            let err = reset_all_on(&host).await.unwrap_err();
            assert_eq!(
                err,
                ResetError {
                    kind,
                    message: format!("{step} broke")
                }
            );
            assert_eq!(host.calls().len(), ran, "{step}");
            // Nothing is deleted until sign-out and the history close are done.
            assert_eq!(host.dir.exists(), ran < 4, "{step}");
        }
    }

    #[tokio::test]
    async fn a_data_dir_that_cannot_be_deleted_is_a_files_error() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let host = Fake::new(file, None);
        let err = reset_all_on(&host).await.unwrap_err();
        assert_eq!(err.kind, "files");
        assert_eq!(host.calls(), ["sign_out", "close_history", "data_dir"]);
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
