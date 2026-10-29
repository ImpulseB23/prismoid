//! Tray icon, close-to-tray, and starting hidden when Windows launches the
//! app at sign-in. The tray is always there so a hidden window can come
//! back; closing only hides the window while the user has asked for that.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State, Window, WindowEvent};

/// Passed by the autostart entry so a sign-in launch stays in the tray.
pub const MINIMIZED_ARG: &str = "--minimized";

#[derive(Default)]
pub struct CloseToTray(AtomicBool);

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, CloseToTray>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

pub fn launched_minimized(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|a| a == MINIMIZED_ARG)
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Prismoid", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Prismoid")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Brings the main window forward, for a user card that sends the user
/// there (a mention to write, a message to jump to).
#[tauri::command]
pub fn show_main_window<R: Runtime>(app: AppHandle<R>) {
    show_main(&app);
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if hides_on_close(window.label(), window.state::<CloseToTray>().inner()) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// Only the main window goes to the tray; user cards always close.
fn hides_on_close(label: &str, state: &CloseToTray) -> bool {
    label == "main" && state.0.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimized_only_with_the_flag() {
        let args = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert!(launched_minimized(
            args(&["prismoid.exe", MINIMIZED_ARG]).into_iter()
        ));
        assert!(!launched_minimized(args(&["prismoid.exe"]).into_iter()));
    }

    #[test]
    fn close_hides_only_when_enabled() {
        let state = CloseToTray::default();
        assert!(!hides_on_close("main", &state));
        state.0.store(true, Ordering::Relaxed);
        assert!(hides_on_close("main", &state));
        assert!(!hides_on_close("user-card-1", &state));
    }
}
