//! Starts the NSIS uninstaller and quits so it can remove the files. The
//! installer writes `uninstall.exe` next to the app's exe; dev builds and
//! other install methods have none, and the UI then points the user at
//! Windows Settings instead.

#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UninstallError {
    /// `not_installed` when there is no uninstaller to run, `launch_failed`
    /// when it would not start.
    pub kind: &'static str,
    pub message: String,
}

impl UninstallError {
    fn not_installed(message: impl Into<String>) -> Self {
        Self {
            kind: "not_installed",
            message: message.into(),
        }
    }
}

#[tauri::command]
pub fn uninstall_app<R: Runtime>(app: AppHandle<R>) -> Result<(), UninstallError> {
    #[cfg(windows)]
    {
        let exe =
            std::env::current_exe().map_err(|e| UninstallError::not_installed(e.to_string()))?;
        let dir = exe
            .parent()
            .ok_or_else(|| UninstallError::not_installed("exe has no parent dir"))?;
        let uninstaller = uninstaller_in(dir)?;
        spawn_detached(&uninstaller).map_err(|e| UninstallError {
            kind: "launch_failed",
            message: e.to_string(),
        })?;
        tracing::info!(path = %uninstaller.display(), "uninstaller started, exiting");
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(UninstallError::not_installed(
            "uninstall is only built for windows",
        ))
    }
}

#[cfg(any(windows, test))]
fn uninstaller_in(exe_dir: &Path) -> Result<PathBuf, UninstallError> {
    let path = exe_dir.join("uninstall.exe");
    if path.is_file() {
        Ok(path)
    } else {
        Err(UninstallError::not_installed(format!(
            "no uninstaller at {}",
            path.display()
        )))
    }
}

/// Runs the uninstaller with its normal UI, outside this process's console
/// and process group so it outlives the exit that follows.
#[cfg(windows)]
fn spawn_detached(path: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

    Command::new(path)
        .creation_flags(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0)
        // A process's working directory cannot be deleted while it runs,
        // so the uninstaller must not inherit the install dir.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_uninstaller_next_to_the_exe() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("prismoid.exe"), b"").unwrap();
        std::fs::write(dir.path().join("uninstall.exe"), b"").unwrap();
        assert_eq!(
            uninstaller_in(dir.path()).unwrap(),
            dir.path().join("uninstall.exe")
        );
    }

    #[test]
    fn missing_uninstaller_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let err = uninstaller_in(dir.path()).unwrap_err();
        assert_eq!(err.kind, "not_installed");
        assert!(err.message.contains("uninstall.exe"));

        std::fs::create_dir(dir.path().join("uninstall.exe")).unwrap();
        assert_eq!(
            uninstaller_in(dir.path()).unwrap_err().kind,
            "not_installed"
        );
    }

    #[test]
    fn error_serializes_as_kind_and_message() {
        assert_eq!(
            serde_json::to_value(UninstallError::not_installed("gone")).unwrap(),
            serde_json::json!({ "kind": "not_installed", "message": "gone" })
        );
    }
}
