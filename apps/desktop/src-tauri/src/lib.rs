pub mod backlog;
pub mod browser_follow;
pub mod chat_history;
mod first_messages;
mod host;
pub mod logging;
mod message;
pub mod oauth_pkce;
mod reset;
pub mod ringbuf;
mod seventv_paints;
mod seventv_users;
mod sidecar_commands;
#[cfg(windows)]
mod sidecar_job;
mod sidecar_supervisor;
mod stream_manager_window;
mod tray;
pub mod twitch_auth;
pub mod twitch_channel;
pub mod twitch_channel_info;
pub mod twitch_chat_settings;
pub mod twitch_irc;
pub mod twitch_polls;
pub mod twitch_quick_actions;
mod uninstall;
pub mod youtube_auth;

pub mod emote_index;

// Re-exports for the bench harness. Gated so the public crate surface
// does not grow with bench-only plumbing in release builds.
#[cfg(any(test, feature = "__bench"))]
#[doc(hidden)]
pub use host::parse_batch;
#[cfg(any(test, feature = "__bench"))]
#[doc(hidden)]
pub use message::UnifiedMessage;

use tauri::{Manager, Runtime, Window, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Visibility is decided at launch (shown, or left in the tray for a
/// sign-in start), never restored: quitting from the tray would otherwise
/// bring the next launch up hidden.
const WINDOW_STATE: StateFlags = StateFlags::all().difference(StateFlags::VISIBLE);

#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

pub fn run() {
    // Phase 0 dev convenience: in debug builds only, load `.env.local` from
    // cwd or any parent before anything reads PRISMOID_TWITCH_*. Release
    // builds skip this entirely so a stray file in the install dir cannot
    // change runtime behavior. Real secret storage uses OS keychain via
    // OAuth, see docs/platform-apis.md §Twitch.
    #[cfg(debug_assertions)]
    match dotenvy::from_filename(".env.local") {
        Ok(_) => {}
        Err(dotenvy::Error::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => eprintln!("failed to load .env.local: {err}"),
    }

    let builder = tauri::Builder::default();
    // Registered first, as the plugin requires: a second launch hands off
    // to the running instance, which brings its window forward, and exits.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        tray::show_main(app);
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    builder
        .plugin(logging::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(tray::CloseToTray::default())
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            get_platform,
            logging::support_bundle,
            reset::reset_settings,
            reset::reset_all_data,
            uninstall::uninstall_app,
            twitch_auth::commands::twitch_auth_status,
            twitch_auth::commands::twitch_start_login,
            twitch_auth::commands::twitch_complete_login,
            twitch_auth::commands::twitch_cancel_login,
            twitch_auth::commands::twitch_logout,
            youtube_auth::commands::youtube_auth_status,
            youtube_auth::commands::youtube_start_login,
            youtube_auth::commands::youtube_complete_login,
            youtube_auth::commands::youtube_cancel_login,
            youtube_auth::commands::youtube_logout,
            sidecar_commands::twitch_send_message,
            sidecar_commands::twitch_ban_user,
            sidecar_commands::twitch_unban_user,
            sidecar_commands::twitch_timeout_user,
            sidecar_commands::twitch_delete_message,
            sidecar_commands::twitch_clear_chat,
            sidecar_commands::twitch_manage_held_message,
            sidecar_commands::youtube_send_message,
            twitch_channel::twitch_join_channel,
            twitch_channel::twitch_leave_channel,
            twitch_channel::twitch_focus_channel,
            twitch_channel::twitch_rejoin_channel,
            browser_follow::set_browser_follow,
            backlog::set_chat_backlog,
            tray::set_close_to_tray,
            first_messages::set_first_messages,
            twitch_channel::twitch_get_channel,
            twitch_channel::twitch_search_channels,
            twitch_channel::twitch_followed_live,
            twitch_channel::twitch_get_stream_info,
            twitch_channel::twitch_lookup_user,
            twitch_channel::twitch_moderated_channels,
            twitch_channel::twitch_users_info,
            sidecar_supervisor::current_emote_bundle,
            sidecar_supervisor::current_sidecar_status,
            seventv_paints::current_seventv_paints,
            seventv_paints::set_seventv_paints,
            seventv_users::seventv_users,
            chat_history::chat_history,
            stream_manager_window::stream_manager_open,
            stream_manager_window::stream_manager_ready,
            twitch_chat_settings::twitch_get_chat_settings,
            twitch_chat_settings::twitch_update_chat_settings,
            twitch_channel_info::twitch_get_channel_info,
            twitch_channel_info::twitch_update_channel_info,
            twitch_channel_info::twitch_search_categories,
            twitch_channel_info::twitch_get_content_labels,
            twitch_polls::twitch_get_poll,
            twitch_polls::twitch_create_poll,
            twitch_polls::twitch_end_poll,
            twitch_polls::twitch_get_prediction,
            twitch_polls::twitch_create_prediction,
            twitch_polls::twitch_lock_prediction,
            twitch_polls::twitch_resolve_prediction,
            twitch_polls::twitch_cancel_prediction,
            twitch_quick_actions::twitch_create_marker,
            twitch_quick_actions::twitch_create_clip,
            twitch_quick_actions::twitch_get_clip,
            twitch_quick_actions::twitch_send_shoutout,
            twitch_quick_actions::twitch_send_announcement,
            twitch_quick_actions::twitch_get_shield_mode,
            twitch_quick_actions::twitch_set_shield_mode,
            twitch_quick_actions::twitch_get_pinned_message,
            twitch_quick_actions::twitch_pin_message,
            twitch_quick_actions::twitch_unpin_message,
        ])
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("failed to run prismoid");
}

fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    tray::on_window_event(window, event);
    if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
        stream_manager_window::close(window.app_handle());
    }
}

/// Tauri setup hook. Builds the shared `AuthManager` + wakeup notifier,
/// registers them as managed state for the auth UI commands, and (on
/// Windows) hands clones to the sidecar supervisor so a successful
/// sign-in wakes it from `waiting_for_auth` immediately. Non-Windows
/// targets log a warning and let the frontend boot without the sidecar
/// (ADR 18).
#[allow(clippy::unnecessary_wraps)]
fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::Arc;

    #[cfg(desktop)]
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())?;
    #[cfg(desktop)]
    app.handle().plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec![tray::MINIMIZED_ARG]),
    ))?;
    tray::install(app.handle())?;
    // Windows gets the in-app title bar (the frontend draws the buttons when
    // it sees an undecorated window); other platforms keep native chrome.
    // Done before the first show so the native frame never flashes.
    #[cfg(windows)]
    if let Some(window) = app.get_webview_window("main") {
        window.set_decorations(false)?;
    }
    if !tray::launched_minimized(std::env::args()) {
        tray::show_main(app.handle());
    }
    use tokio::sync::Notify;
    use twitch_auth::{AuthManager, AuthState, KeychainStore, TWITCH_CLIENT_ID};
    use twitch_oauth2::Scope;

    let http_client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            tracing::error!(
                error = %err,
                "failed to build reqwest client; skipping auth manager and sidecar"
            );
            return Ok(());
        }
    };
    app.manage(seventv_users::SevenTvUsers::new(http_client.clone()));
    let auth = Arc::new(
        AuthManager::builder(TWITCH_CLIENT_ID)
            .scope(Scope::UserReadChat)
            .scope(Scope::UserWriteChat)
            .scope(Scope::UserReadModeratedChannels)
            .scope(Scope::UserReadFollows)
            .scope(Scope::ModeratorManageBannedUsers)
            .scope(Scope::ModeratorManageChatMessages)
            // Chat settings are read and changed from the chat modes panel.
            // The remaining read scopes are what channel.moderate v2 asks
            // for, so moderators see every action in the channel with
            // who took it and why.
            .scope(Scope::ModeratorReadBlockedTerms)
            .scope(Scope::ModeratorReadChatSettings)
            .scope(Scope::ModeratorManageChatSettings)
            .scope(Scope::ModeratorReadUnbanRequests)
            .scope(Scope::ModeratorReadWarnings)
            .scope(Scope::ModeratorReadModerators)
            .scope(Scope::ModeratorReadVips)
            // Held AutoMod messages: both EventSub feeds and allow/deny.
            .scope(Scope::ModeratorManageAutoMod)
            // Stream manager on the user's own channel: title and category,
            // polls and predictions. The manage scopes also cover reading
            // them and their EventSub feeds.
            .scope(Scope::ChannelManageBroadcast)
            .scope(Scope::ChannelManagePolls)
            .scope(Scope::ChannelManagePredictions)
            .build(KeychainStore, http_client),
    );
    let wakeup = Arc::new(Notify::new());
    let auth_state = AuthState::new(auth.clone(), wakeup.clone());
    let signed_in = auth_state.signed_in.clone();
    app.manage(auth_state);

    // Twitch's answer comes back as a prismoid:// link (ADR 43). The
    // installer registers the scheme for Windows releases; dev builds and
    // Linux register it at runtime.
    #[cfg(desktop)]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
        app.deep_link().register_all()?;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let auth = handle.state::<AuthState>();
            for url in event.urls() {
                auth.deliver_deep_link(&url);
            }
        });
    }

    // YouTube auth manager + state. Sidecar wiring lands separately —
    // this PR only stands up the OAuth + keychain stack and the
    // frontend sign-in surface; the supervisor still only knows
    // about Twitch tokens. ADR 39.
    {
        use youtube_auth::{
            AuthManager as YtAuthManager, AuthState as YtAuthState,
            KeychainStore as YtKeychainStore, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
            SCOPE_YOUTUBE, SCOPE_YOUTUBE_READONLY,
        };
        match reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(yt_http_client) => {
                let yt_auth = Arc::new(
                    YtAuthManager::builder(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
                        .scope(SCOPE_YOUTUBE_READONLY)
                        .scope(SCOPE_YOUTUBE)
                        .build(YtKeychainStore, yt_http_client),
                );
                let yt_wakeup = Arc::new(Notify::new());
                app.manage(YtAuthState::new(yt_auth, yt_wakeup));
            }
            Err(err) => {
                tracing::error!(
                    error = %err,
                    "failed to build reqwest client for YouTube; skipping YouTube auth wiring"
                );
            }
        }
    }

    let sender = sidecar_commands::SidecarCommandSender::default();
    app.manage(sender.clone());
    app.manage(sidecar_supervisor::EmoteBundleState::default());
    app.manage(sidecar_supervisor::SidecarStatusState::default());
    app.manage(seventv_paints::PaintState::default());
    app.manage(seventv_paints::PaintSetting::default());

    let (channel_state, channel_rx) = twitch_channel::ChannelState::new();
    app.manage(channel_state);

    let history = app
        .path()
        .app_data_dir()
        .map_err(Into::into)
        .and_then(|dir| chat_history::History::open(&dir))
        .unwrap_or_else(|err| {
            tracing::error!(error = %err, "chat history unavailable; running without a backlog");
            chat_history::History::default()
        });
    app.manage(history.clone());
    app.manage(backlog::BacklogSetting::default());
    app.manage(first_messages::FirstMessageSetting::default());

    let follow = browser_follow::BrowserFollow::default();
    app.manage(follow.clone());
    #[cfg(windows)]
    browser_follow::spawn(app.app_handle().clone(), follow);
    #[cfg(not(windows))]
    drop(follow);

    #[cfg(windows)]
    {
        sidecar_supervisor::spawn(
            app.app_handle().clone(),
            auth,
            wakeup,
            signed_in,
            sender,
            channel_rx,
            history,
        );
    }
    #[cfg(not(windows))]
    {
        let _ = (auth, wakeup, signed_in, sender, channel_rx, history);
        tracing::warn!(
            "sidecar lifecycle is Windows-only for now; launching frontend without sidecar"
        );
    }
    Ok(())
}
