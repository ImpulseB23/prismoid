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
        uninstall(std::env::current_exe(), spawn_detached, || app.exit(0))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(UninstallError::not_installed(
            "uninstall is only built for windows",
        ))
    }
}

/// Starts the uninstaller found next to `exe` with `spawn`, then `exit`s.
#[cfg(any(windows, test))]
fn uninstall(
    exe: std::io::Result<PathBuf>,
    spawn: impl FnOnce(&Path) -> std::io::Result<()>,
    exit: impl FnOnce(),
) -> Result<(), UninstallError> {
    let exe = exe.map_err(|e| UninstallError::not_installed(e.to_string()))?;
    let dir = exe
        .parent()
        .ok_or_else(|| UninstallError::not_installed("exe has no parent dir"))?;
    let path = dir.join("uninstall.exe");
    if !path.is_file() {
        return Err(UninstallError::not_installed(format!(
            "no uninstaller at {}",
            path.display()
        )));
    }
    spawn(&path).map_err(|e| UninstallError {
        kind: "launch_failed",
        message: e.to_string(),
    })?;
    tracing::info!(path = %path.display(), "uninstaller started, exiting");
    exit();
    Ok(())
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

    use std::cell::{Cell, RefCell};
    use std::io;

    /// Runs `uninstall` for an exe at `exe`, recording what got spawned and
    /// whether the app exited.
    fn run(
        exe: io::Result<PathBuf>,
        spawn_result: io::Result<()>,
    ) -> (Result<(), UninstallError>, Option<PathBuf>, bool) {
        let spawned = RefCell::new(None);
        let exited = Cell::new(false);
        let result = uninstall(
            exe,
            |path| {
                *spawned.borrow_mut() = Some(path.to_owned());
                spawn_result
            },
            || exited.set(true),
        );
        (result, spawned.into_inner(), exited.get())
    }

    fn install_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("prismoid.exe"), b"").unwrap();
        std::fs::write(dir.path().join("uninstall.exe"), b"").unwrap();
        dir
    }

    #[test]
    fn starts_the_uninstaller_next_to_the_exe_then_exits() {
        let dir = install_dir();
        let (result, spawned, exited) = run(Ok(dir.path().join("prismoid.exe")), Ok(()));
        result.unwrap();
        assert_eq!(spawned, Some(dir.path().join("uninstall.exe")));
        assert!(exited);
    }

    #[test]
    fn missing_uninstaller_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("prismoid.exe");
        let (result, spawned, exited) = run(Ok(exe.clone()), Ok(()));
        let err = result.unwrap_err();
        assert_eq!(err.kind, "not_installed");
        assert!(err.message.contains("uninstall.exe"));
        assert_eq!((spawned, exited), (None, false));

        std::fs::create_dir(dir.path().join("uninstall.exe")).unwrap();
        assert_eq!(run(Ok(exe), Ok(())).0.unwrap_err().kind, "not_installed");
    }

    #[test]
    fn unknown_exe_location_is_not_installed() {
        let (result, spawned, exited) = run(Err(io::Error::other("no exe path")), Ok(()));
        assert_eq!(
            result.unwrap_err(),
            UninstallError::not_installed("no exe path")
        );
        assert_eq!((spawned, exited), (None, false));

        let (result, _, exited) = run(Ok(PathBuf::new()), Ok(()));
        assert_eq!(result.unwrap_err().kind, "not_installed");
        assert!(!exited);
    }

    #[test]
    fn a_failed_spawn_keeps_the_app_running() {
        let dir = install_dir();
        let (result, spawned, exited) = run(
            Ok(dir.path().join("prismoid.exe")),
            Err(io::Error::other("access denied")),
        );
        assert_eq!(
            result.unwrap_err(),
            UninstallError {
                kind: "launch_failed",
                message: "access denied".into()
            }
        );
        assert!(spawned.is_some());
        assert!(!exited);
    }

    #[test]
    fn error_serializes_as_kind_and_message() {
        assert_eq!(
            serde_json::to_value(UninstallError::not_installed("gone")).unwrap(),
            serde_json::json!({ "kind": "not_installed", "message": "gone" })
        );
    }
}
