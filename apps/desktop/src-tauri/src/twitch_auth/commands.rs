//! Tauri command surface for the Twitch sign-in UI.
//!
//! These functions are thin adapters over [`AuthState`] (in `auth_state.rs`).
//! All branchable logic lives in `AuthState` and is unit-tested there;
//! these wrappers exist purely so `tauri::generate_handler!` can route
//! IPC calls. They're excluded from coverage in `codecov.yml` because
//! exercising them requires a Tauri runtime + WebView2 host process.
//!
//! Frontend flow:
//! 1. App boot → `twitch_auth_status` to render either the chat view
//!    (logged in) or the SignIn overlay (logged out).
//! 2. User clicks "Sign in with Twitch" → `twitch_start_login` returns the
//!    authorize URL. The frontend opens it in the system browser and
//!    immediately calls `twitch_complete_login`, which blocks until Twitch's
//!    answer arrives over the prismoid:// deep link, the user cancels, or
//!    the ten minute window runs out.
//! 3. On success, the supervisor's wakeup notifier fires so it picks
//!    up the new tokens without waiting out its 30 s `waiting_for_auth`
//!    sleep.
//! 4. `twitch_logout` wipes the keychain entry and re-shows the overlay
//!    on the next supervisor iteration.

use tauri::{AppHandle, Emitter, Runtime, State};

use super::auth_state::{AuthCommandError, AuthState, AuthStatus, LoginView};

/// Sent to every window after a sign-in, reconnect or sign-out, so the
/// windows besides the one that started it follow the account too.
pub const AUTH_CHANGED: &str = "twitch_auth_changed";

fn announce<R: Runtime>(app: &AppHandle<R>, status: &AuthStatus) {
    if let Err(e) = app.emit(AUTH_CHANGED, status) {
        tracing::warn!(error = %e, "auth change not announced");
    }
}

#[tauri::command]
pub async fn twitch_auth_status(
    state: State<'_, AuthState>,
) -> Result<AuthStatus, AuthCommandError> {
    state.status()
}

#[tauri::command]
pub async fn twitch_start_login(
    state: State<'_, AuthState>,
) -> Result<LoginView, AuthCommandError> {
    state.start_login().await
}

#[tauri::command]
pub async fn twitch_complete_login<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AuthState>,
) -> Result<AuthStatus, AuthCommandError> {
    let status = state.complete_login().await?;
    announce(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn twitch_cancel_login(state: State<'_, AuthState>) -> Result<(), AuthCommandError> {
    state.cancel_login().await;
    Ok(())
}

#[tauri::command]
pub async fn twitch_logout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AuthState>,
) -> Result<(), AuthCommandError> {
    state.logout().await?;
    announce(&app, &state.status()?);
    Ok(())
}
