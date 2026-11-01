pub mod backlog;
mod browser_args;
pub mod browser_follow;
pub mod chat_history;
mod first_messages;
mod host;
mod ivr;
mod launch_update;
pub mod logging;
mod message;
pub mod oauth_pkce;
mod reset;
pub mod ringbuf;
mod seventv_emotes;
mod seventv_paints;
mod seventv_users;
mod sidecar_commands;
#[cfg(windows)]
mod sidecar_job;
mod sidecar_supervisor;
mod storage_move;
mod tray;
mod ttl_cache;
pub mod twitch_ads;
pub mod twitch_auth;
pub mod twitch_channel;
pub mod twitch_channel_info;
pub mod twitch_chat_settings;
mod twitch_feeds;
pub mod twitch_irc;
pub mod twitch_polls;
pub mod twitch_quick_actions;
mod uninstall;
mod update_splash;
mod user_card;
mod video_window;
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
/// bring the next launch up hidden. Fullscreen is not restored either; a
/// launch always opens as a normal window.
const WINDOW_STATE: StateFlags = StateFlags::all()
    .difference(StateFlags::VISIBLE)
    .difference(StateFlags::FULLSCREEN);

#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    if let Some(splash) = update_splash::parse(std::env::args()) {
        run_update_splash(context, splash);
        return;
    }

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
                // Cards always open at the mouse; the storage move window
                // is never shown.
                .with_filter(|label| !user_card::is_card(label) && label != storage_move::LABEL)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(tray::CloseToTray::default())
        .manage(user_card::UserCards::default())
        .manage(ivr::SubAgeCache::default())
        .manage(storage_move::StorageMove::default())
        .manage(launch_update::LaunchCheck::default())
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            get_platform,
            logging::support_bundle,
            reset::reset_settings,
            reset::reset_all_data,
            uninstall::uninstall_app,
            update_splash::update_splash_start,
            launch_update::launch_update_done,
            launch_update::launch_update_ran,
            twitch_auth::commands::twitch_auth_status,
            twitch_auth::commands::twitch_start_login,
            twitch_auth::commands::twitch_complete_login,
            twitch_auth::commands::twitch_cancel_login,
            twitch_auth::commands::twitch_logout,
            twitch_auth::commands::twitch_enable_scope_group,
            twitch_auth::commands::twitch_disable_scope_group,
            youtube_auth::commands::youtube_auth_status,
            youtube_auth::commands::youtube_start_login,
            youtube_auth::commands::youtube_complete_login,
            youtube_auth::commands::youtube_cancel_login,
            youtube_auth::commands::youtube_logout,
            sidecar_commands::twitch_send_message,
            sidecar_commands::twitch_ban_user,
            sidecar_commands::twitch_unban_user,
            sidecar_commands::twitch_timeout_user,
            sidecar_commands::twitch_warn_user,
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
            tray::show_main_window,
            first_messages::set_first_messages,
            twitch_feeds::set_twitch_feed,
            seventv_emotes::set_seventv_emotes,
            twitch_channel::twitch_get_channel,
            twitch_channel::twitch_search_channels,
            twitch_channel::twitch_followed_live,
            twitch_channel::twitch_get_stream_info,
            twitch_channel::twitch_live_channels,
            twitch_channel::twitch_lookup_user,
            twitch_channel::twitch_moderated_channels,
            twitch_channel::twitch_users_info,
            twitch_channel::twitch_follow_since,
            twitch_channel::twitch_follower_count,
            ivr::twitch_subage,
            twitch_channel::twitch_own_chat_color,
            twitch_channel::twitch_update_chat_color,
            sidecar_supervisor::current_emote_bundle,
            sidecar_supervisor::current_sidecar_status,
            seventv_paints::current_seventv_paints,
            seventv_paints::seventv_user_paint,
            seventv_paints::set_seventv_paints,
            seventv_users::seventv_users,
            chat_history::chat_history,
            chat_history::chat_history_user,
            user_card::commands::user_card_open,
            user_card::commands::user_card_current,
            user_card::commands::user_card_ready,
            user_card::commands::user_card_set_pinned,
            user_card::commands::user_card_close,
            storage_move::commands::storage_move_import,
            storage_move::commands::storage_move_imported,
            storage_move::commands::storage_move_export,
            storage_move::commands::storage_move_finish,
            video_window::video_window_open,
            video_window::video_windows_close,
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
            twitch_ads::twitch_get_ad_schedule,
            twitch_ads::twitch_snooze_next_ad,
            twitch_ads::twitch_start_commercial,
        ])
        .setup(setup)
        .run(context)
        .expect("failed to run prismoid");
}

/// Splash mode: one small window that covers an update until the new
/// version is up (see `update_splash`). No plugins, so it never takes the
/// single-instance lock the new version needs.
#[cfg(windows)]
fn run_update_splash(mut context: tauri::Context, splash: update_splash::Splash) {
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // The config's main window would otherwise open and boot the whole app.
    context.config_mut().app.windows.clear();
    // Created before anything else: the installer takes seconds, so the
    // event exists long before the new version looks for it.
    let done = match update_splash::Handle::event() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("update splash event: {e}");
            return;
        }
    };
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                update_splash::LABEL,
                WebviewUrl::App(splash.url().into()),
            )
            .title("Updating prismoid")
            .inner_size(340.0, 230.0)
            .resizable(false)
            .maximizable(false)
            .decorations(false)
            .center()
            .visible(false)
            .data_directory(update_splash::webview_dir())
            // Shown once drawn, so it never flashes an empty frame.
            .on_page_load(|window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = window.show();
                }
            })
            .build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                update_splash::finish(&splash, &done, &update_splash::WAITS, || {
                    if let Some(window) = app.get_webview_window(update_splash::LABEL) {
                        let _ = window.eval("location.hash = 'failed'");
                    }
                });
                app.exit(0);
            });
            Ok(())
        })
        .run(context)
        .expect("failed to run the update splash");
}

fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    tray::on_window_event(window, event);
    if window.label() == "main" {
        match event {
            WindowEvent::Destroyed => user_card::close_all(window.app_handle()),
            WindowEvent::Focused(true) => user_card::main_focused(window.app_handle()),
            _ => {}
        }
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
    storage_move::commands::start(app.handle())?;
    // Windows gets the in-app title bar (the frontend draws the buttons when
    // it sees an undecorated window); other platforms keep native chrome.
    // Done before the first show so the native frame never flashes.
    #[cfg(windows)]
    if let Some(window) = app.get_webview_window("main") {
        window.set_decorations(false)?;
    }
    // A normal start opens in the startup window, which looks for an update
    // before the app shows. Dev builds do not update; a start into the tray
    // stays quiet and checks in the background.
    if !tray::launched_minimized(std::env::args()) {
        if tauri::is_dev() {
            tray::show_main(app.handle());
        } else if let Err(e) = launch_update::start(app.handle()) {
            tracing::error!(error = %e, "startup window failed, opening the app");
            tray::show_main(app.handle());
        }
    }
    #[cfg(windows)]
    update_splash::release();
    use tokio::sync::Notify;
    use twitch_auth::{AuthManager, AuthState, KeychainStore, ScopeGroups, TWITCH_CLIENT_ID};
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
    let scope_groups = match app.path().app_data_dir() {
        Ok(dir) => ScopeGroups::open(&dir),
        Err(err) => {
            tracing::error!(error = %err, "no app data dir; scope groups last until exit");
            ScopeGroups::default()
        }
    };
    let auth = Arc::new(
        AuthManager::builder(TWITCH_CLIENT_ID)
            .scope(Scope::UserReadChat)
            .scope(Scope::UserWriteChat)
            .scope(Scope::UserReadModeratedChannels)
            .scope(Scope::UserReadFollows)
            .scope(Scope::ModeratorManageBannedUsers)
            .scope(Scope::ModeratorManageChatMessages)
            .scope(Scope::ModeratorManageWarnings)
            // Follow age on user cards, in channels the user moderates.
            .scope(Scope::ModeratorReadFollowers)
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
            .scope_groups(scope_groups)
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
    app.manage(twitch_feeds::TwitchFeedSetting::default());
    app.manage(seventv_emotes::SevenTvEmoteSetting::default());

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
