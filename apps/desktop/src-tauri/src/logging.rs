//! Log file for bug reports. The host logs through `tracing` with its `log`
//! feature and no subscriber installed, so every event lands on the `log`
//! facade that the log plugin owns; the webview forwards its warnings and
//! errors through the same plugin. One file under the OS log directory
//! holds both sides.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_opener::OpenerExt;

/// Rotation point. A few rotated files stay behind so a report filed after
/// a restart still has the run that went wrong.
const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;
const KEEP_FILES: usize = 3;

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("prismoid", log::LevelFilter::Debug)
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_FILES))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: None }));
    // Release builds run without a console on Windows, so only dev builds
    // mirror the file to the terminal.
    #[cfg(debug_assertions)]
    let builder = builder.target(Target::new(TargetKind::Stdout));
    builder.build()
}

#[tauri::command]
pub fn open_log_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
