//! Sidecar supervisor: owns the full lifecycle of the Go sidecar child
//! process. Spawns it, wires up the shared-memory ring, forwards stdout/stderr
//! to tracing, and respawns on termination with exponential backoff.
//!
//! The supervisor runs as a single long-lived tokio task kicked off from
//! `lib::setup`. Each iteration creates a fresh mapping + event pair
//! (handles are single-use by design, since the child closes them on exit)
//! and tears them down when the child dies. Emits `sidecar_status` events
//! on every state transition so the frontend can react without a second
//! refactor when UI chrome lands.
//!
//! Non-Windows targets are not supported yet; the supervisor is gated
//! behind `cfg(windows)` and callers fall back to a warn-and-bail in
//! `lib::setup`.

#[cfg(windows)]
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(windows)]
use std::time::Instant;
#[cfg(windows)]
use tauri::Manager;
#[cfg(windows)]
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[cfg(windows)]
use crate::backlog::{self, BacklogSetting};
use crate::chat_history::History;
use crate::emote_index::EmoteBundle;
#[cfg(windows)]
use crate::emote_index::EmoteIndexes;
#[cfg(windows)]
use crate::first_messages::FirstMessageSetting;
#[cfg(windows)]
use crate::host::{
    build_bootstrap_line, build_token_refresh_line, build_twitch_connect_line,
    build_twitch_disconnect_line, build_twitch_resubscribe_line, mark_handle_inheritable,
    parse_batch, parse_sidecar_event, unmark_handle_inheritable, SidecarEvent, TwitchCreds,
    SIDECAR_BINARY, SIGNAL_WAIT_TIMEOUT,
};
use crate::message::{assign_arrival_seqs, ChatEvent, UnifiedMessage};
#[cfg(windows)]
use crate::ringbuf::{RawHandle, RingBufReader, WaitOutcome, DEFAULT_CAPACITY};
#[cfg(windows)]
use crate::seventv_paints::{PaintEvent, PaintSetting, PaintState};
#[cfg(windows)]
use crate::sidecar_commands::SidecarCommandSender;
#[cfg(windows)]
use crate::sidecar_job::SidecarJob;
#[cfg(windows)]
use crate::twitch_auth::{AuthError, AuthManager, TWITCH_CLIENT_ID};
#[cfg(windows)]
use crate::twitch_channel::{Channel, ChannelSelection};
use crate::twitch_feeds::TwitchFeedSetting;
#[cfg(windows)]
use tokio::sync::{watch, Notify};

/// Supervisor timings. Defaults are production values; tests can override.
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// A sidecar run whose uptime reaches this threshold is considered
    /// healthy, and the backoff resets to `initial_backoff` on its next
    /// termination. Without this the ladder would only ever ratchet up,
    /// even if the sidecar was stable for hours between crashes.
    pub healthy_threshold: Duration,
    /// Maximum gap between heartbeats from the sidecar before the
    /// supervisor declares the child unhealthy and force-kills it to
    /// trigger a respawn. `docs/stability.md` §Sidecar Health specifies
    /// 3 missed heartbeats at a 1 s interval, so the default is 3 s.
    pub heartbeat_timeout: Duration,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(30),
            healthy_threshold: Duration::from_secs(60),
            heartbeat_timeout: Duration::from_secs(3),
        }
    }
}

/// Doubles the current backoff, clamped to `cfg.max_backoff`. Pure function
/// so the exponential ladder can be tested without spinning the runtime.
pub fn next_backoff(current: Duration, cfg: &SupervisorConfig) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > cfg.max_backoff {
        cfg.max_backoff
    } else {
        doubled
    }
}

/// Emitted to the frontend on every supervisor state transition. The UI
/// ticket will listen for this; today nothing consumes it, but shipping
/// the event now means we don't have to touch the supervisor again.
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub state: &'static str,
    pub attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backoff_ms: Option<u64>,
}

/// Kicks off the supervisor. Returns immediately; the supervisor runs on
/// a tauri async task until the app exits. The caller passes in the
/// shared [`AuthManager`] (also held by Tauri managed state for the
/// auth UI commands) and a `wakeup` notifier the supervisor awaits
/// while idle in `waiting_for_auth` so a successful sign-in starts the
/// sidecar within milliseconds instead of waiting out the 30 s poll.
#[cfg(windows)]
pub fn spawn<R: Runtime>(
    app: AppHandle<R>,
    auth: Arc<AuthManager>,
    wakeup: Arc<Notify>,
    signed_in: Arc<Notify>,
    sender: SidecarCommandSender,
    channels: watch::Receiver<ChannelSelection>,
    history: History,
) {
    tauri::async_runtime::spawn(async move {
        supervise(app, auth, wakeup, signed_in, sender, channels, history).await;
    });
}

#[cfg(windows)]
async fn supervise<R: Runtime>(
    app: AppHandle<R>,
    auth: Arc<AuthManager>,
    wakeup: Arc<Notify>,
    signed_in: Arc<Notify>,
    sender: SidecarCommandSender,
    channels: watch::Receiver<ChannelSelection>,
    history: History,
) {
    // `client_id` lives in the shared AuthManager; broadcaster/user
    // identifiers ride inside the persisted [`TwitchTokens`] itself
    // (populated from token validation, stable across refresh).
    // Tokens live in the OS keychain, seeded via the SignIn overlay and
    // rotated automatically below (ADR 29).
    let cfg = SupervisorConfig::default();
    let mut attempt: u32 = 0;
    let mut backoff = cfg.initial_backoff;
    // Per-process monotonic arrival counter. Owned by `supervise` so it
    // survives sidecar respawns; without this, every respawn would reset
    // `arrival_seq` to 0 and break `(effective_ts, arrival_seq)` as a
    // stable sort key across the boundary.
    let arrival_seq = Arc::new(AtomicU64::new(0));
    // One job for every sidecar this supervisor ever spawns; Windows ends
    // whatever is in it when this process exits, however it exits.
    let job = SidecarJob::new().expect("create the sidecar job object");

    loop {
        attempt += 1;
        emit_status(&app, "spawning", attempt, None);

        // Pull a fresh access token per iteration. Auto-refresh happens
        // inside load_or_refresh when we're within 5 min of expiry.
        let tokens = match auth.load_or_refresh().await {
            Ok(t) => t,
            Err(AuthError::NoTokens) | Err(AuthError::RefreshTokenInvalid) => {
                tracing::warn!(
                    "no valid Twitch tokens in keychain; click Sign in with Twitch in the app"
                );
                emit_status(&app, "waiting_for_auth", attempt, None);
                // Wait on the shared notifier (fired by
                // `twitch_complete_login` / `twitch_logout`) with a 30 s
                // floor so a process that boots before the keychain
                // service still recovers without a restart. Not a
                // respawn-pressure scenario, so we stay on a fixed
                // interval rather than the exponential ladder.
                let _ = tokio::time::timeout(Duration::from_secs(30), wakeup.notified()).await;
                continue;
            }
            Err(e) => {
                tracing::error!(error = %e, attempt, "token refresh failed; backing off");
                emit_status(&app, "backoff", attempt, Some(backoff.as_millis() as u64));
                tokio::time::sleep(backoff).await;
                backoff = next_backoff(backoff, &cfg);
                continue;
            }
        };

        let started = Instant::now();
        let ctx = RunContext {
            app: &app,
            cfg: &cfg,
            sender: &sender,
            auth: &auth,
            signed_in: &signed_in,
            arrival_seq: &arrival_seq,
            history: &history,
            job: &job,
        };
        match run_once(
            &ctx,
            attempt,
            tokens.user_id,
            tokens.login,
            tokens.scopes,
            channels.clone(),
        )
        .await
        {
            Ok(()) => tracing::info!(attempt, "sidecar iteration ended"),
            Err(e) => tracing::error!(error = %e, attempt, "sidecar iteration failed"),
        }
        // Always clear any lingering child handle once the iteration
        // ends, even on error paths above. Drops the CommandChild and
        // closes its stdin so the next iteration starts from a clean slate.
        let _ = sender.clear();

        if started.elapsed() >= cfg.healthy_threshold {
            backoff = cfg.initial_backoff;
            tracing::info!("sidecar run was healthy, backoff reset");
        }

        emit_status(&app, "backoff", attempt, Some(backoff.as_millis() as u64));
        tokio::time::sleep(backoff).await;
        backoff = next_backoff(backoff, &cfg);
    }
}

/// RAII wrapper that kills the wrapped sidecar on drop unless [`release`]
/// is called first. Used in [`run_once`] to avoid leaking children when a
/// post-spawn step (bootstrap serialize, stdin write, etc.) returns early
/// with `?`.
///
/// [`release`]: ChildGuard::release
#[cfg(windows)]
struct ChildGuard {
    inner: Option<CommandChild>,
}

#[cfg(windows)]
impl ChildGuard {
    fn new(child: CommandChild) -> Self {
        Self { inner: Some(child) }
    }

    /// Disarms the kill-on-drop and returns the wrapped child. Call this
    /// once the [`CommandEvent`] stream has taken over the child's
    /// lifecycle — every subsequent termination flows through
    /// [`CommandEvent::Terminated`], so an explicit kill is redundant.
    fn release(mut self) -> CommandChild {
        self.inner.take().expect("release called at most once")
    }
}

#[cfg(windows)]
impl std::ops::Deref for ChildGuard {
    type Target = CommandChild;
    fn deref(&self) -> &CommandChild {
        self.inner.as_ref().expect("child still owned by guard")
    }
}

#[cfg(windows)]
impl std::ops::DerefMut for ChildGuard {
    fn deref_mut(&mut self) -> &mut CommandChild {
        self.inner.as_mut().expect("child still owned by guard")
    }
}

#[cfg(windows)]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.inner.take() {
            if let Err(e) = child.kill() {
                tracing::error!(error = %e, "failed to kill sidecar on error path");
            }
        }
    }
}

/// Handles that outlive a single sidecar run and are shared by every
/// iteration of [`supervise`].
#[cfg(windows)]
#[derive(Clone, Copy)]
struct RunContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    cfg: &'a SupervisorConfig,
    sender: &'a SidecarCommandSender,
    auth: &'a Arc<AuthManager>,
    signed_in: &'a Arc<Notify>,
    arrival_seq: &'a Arc<AtomicU64>,
    history: &'a History,
    job: &'a SidecarJob,
}

#[cfg(windows)]
async fn run_once<R: Runtime>(
    ctx: &RunContext<'_, R>,
    attempt: u32,
    own_user_id: String,
    own_login: String,
    granted: Vec<String>,
    channels: watch::Receiver<ChannelSelection>,
) -> Result<(), Box<dyn std::error::Error>> {
    let RunContext {
        app,
        cfg,
        sender,
        auth,
        signed_in,
        arrival_seq,
        history,
        job,
    } = *ctx;
    let reader = RingBufReader::create_owner(DEFAULT_CAPACITY)?;
    let handle = reader.raw_handle();
    let event_handle = reader
        .raw_event_handle()
        .expect("owner-created reader has event handle");
    let size = reader.map_size();

    mark_handle_inheritable(handle)?;
    if let Err(e) = mark_handle_inheritable(event_handle) {
        if let Err(undo) = unmark_handle_inheritable(handle) {
            tracing::error!(error = %undo, "failed to undo mapping mark after event mark failure");
        }
        return Err(e.into());
    }

    // RAII guard: clears the inheritable flag on both handles when dropped,
    // including on any unwinding error path between mark and explicit drop.
    // See ADR 18 and the Rust stdlib `CREATE_PROCESS_LOCK` comment for why
    // the window matters.
    struct InheritGuard {
        mapping: RawHandle,
        event: RawHandle,
    }
    impl Drop for InheritGuard {
        fn drop(&mut self) {
            if let Err(e) = unmark_handle_inheritable(self.mapping) {
                tracing::error!(error = %e, "failed to un-mark mapping inheritance");
            }
            if let Err(e) = unmark_handle_inheritable(self.event) {
                tracing::error!(error = %e, "failed to un-mark event inheritance");
            }
        }
    }
    let inherit_guard = InheritGuard {
        mapping: handle,
        event: event_handle,
    };

    let (mut rx, child) = app.shell().sidecar(SIDECAR_BINARY)?.spawn()?;
    // Spawn succeeded; child has inherited both handles. Clear the flags
    // now, not at scope exit, so any process we happen to spawn between
    // here and termination does not inherit the shared-memory handle.
    drop(inherit_guard);

    // Wrap the child so any `?` return between here and the event loop
    // kills it instead of leaking a zombie across respawn iterations.
    let mut child = ChildGuard::new(child);
    // Bound before the bootstrap line, so a child that never gets one
    // still goes with us.
    job.assign(child.pid())?;

    let bootstrap_line = build_bootstrap_line(handle, event_handle, size)?;
    child.write(&bootstrap_line)?;
    tracing::info!(attempt, "sidecar bootstrap written");

    // Disarm the kill-on-drop: the CommandEvent stream now owns the
    // child's lifecycle. Publish the released CommandChild into the
    // shared sender so Tauri commands can write control lines into its
    // stdin for the duration of the session. The heartbeat-timeout
    // branch below pulls it back out via `sender.clear()` for an
    // explicit kill, and the outer `supervise` loop also clears any
    // lingering handle once the iteration ends.
    sender.publish(child.release());
    app.state::<FirstMessageSetting>()
        .sync(|line| sender.write_raw(line));
    app.state::<PaintSetting>()
        .sync(|line| sender.write_raw(line));
    app.state::<TwitchFeedSetting>()
        .sync(|line| sender.write_raw(line));

    // The channel task owns every twitch_connect / twitch_disconnect
    // write for this run: it sends the initial connect for whichever
    // channel is selected right now and re-points the subscription on
    // each later selection change. Routing all of it through one task
    // means a switch can never interleave with the initial connect.
    // EmoteIndexes lives for the lifetime of this sidecar run; a fresh one is
    // built on every respawn. Shared by the control-plane reader (which
    // swaps in fresh bundles on `emote_bundle`), the drain loop (which
    // scans each parsed message against the current snapshot) and backlog
    // imports.
    let emote_index: Arc<EmoteIndexes> = Arc::new(EmoteIndexes::new());

    let channel_handle = {
        let auth = Arc::clone(auth);
        let sender = sender.clone();
        let app = app.clone();
        let history = history.clone();
        let emote_index = emote_index.clone();
        tauri::async_runtime::spawn(async move {
            channel_switch_loop(
                channels,
                own_user_id,
                own_login,
                auth,
                sender,
                BacklogDeps {
                    app,
                    history,
                    emote_index,
                },
            )
            .await;
        })
    };

    let shutdown = Arc::new(AtomicBool::new(false));
    let drain_shutdown = shutdown.clone();
    let drain_app = app.clone();
    let drain_index = emote_index.clone();
    let drain_seq = Arc::clone(arrival_seq);
    let drain_history = history.clone();
    let drain_handle = tauri::async_runtime::spawn_blocking(move || {
        run_drain_loop(
            reader,
            drain_app,
            drain_shutdown,
            drain_index,
            drain_seq,
            &drain_history,
        );
    });

    emit_status(app, "running", attempt, None);

    // Proactive token refresh (ADR 29): periodically check if the Twitch
    // token is near expiry and push a fresh one to the sidecar so EventSub
    // reconnects don't fail with a stale credential. The task is cancelled
    // when the event loop exits (sidecar death or heartbeat timeout). A
    // sign-in wakes it early, and one that changed the granted scopes
    // has the sidecar subscribe what the new grant allows.
    let refresh_handle = {
        let auth = Arc::clone(auth);
        let signed_in = Arc::clone(signed_in);
        let sender = sender.clone();
        tauri::async_runtime::spawn(async move {
            token_refresh_loop(auth, granted, signed_in, sender).await;
        })
    };

    run_event_loop(
        &mut rx,
        cfg.heartbeat_timeout,
        attempt,
        |bytes| handle_sidecar_stdout(bytes, app, &emote_index, sender),
        || {
            if let Some(c) = sender.clear() {
                if let Err(e) = c.kill() {
                    tracing::error!(error = %e, "kill after heartbeat timeout failed");
                }
            }
        },
        || emit_status(app, "unhealthy", attempt, None),
    )
    .await;

    refresh_handle.abort();
    channel_handle.abort();

    // Release-store the shutdown flag; the drain loop does an Acquire-load
    // at the top of every iteration and exits after one final drain pass
    // so no pending messages are dropped on the floor.
    shutdown.store(true, Ordering::Release);
    if let Err(e) = drain_handle.await {
        tracing::error!(error = %e, "drain task join failed");
    }

    emit_status(app, "terminated", attempt, None);
    Ok(())
}

/// Drives the CommandEvent stream until the sidecar terminates or its
/// heartbeat stream goes silent for longer than `heartbeat_timeout`.
///
/// Extracted from [`run_once`] so the heartbeat/respawn logic can be
/// tested without a real Tauri runtime. Callers inject:
/// * `on_stdout`: parses each stdout batch and returns `true` if any
///   line was a heartbeat (resets the timeout deadline).
/// * `on_timeout_kill`: force-kills the child process. Called at most
///   once, the first time the heartbeat deadline elapses.
/// * `on_unhealthy`: emits the "unhealthy" sidecar status so the
///   frontend can render a respawn indicator.
///
/// After the first timeout fires the timeout branch is disabled and the
/// loop keeps draining events so the outer supervise loop doesn't race a
/// respawn against the dying child: we exit only on `Terminated` or when
/// the event stream closes on its own.
#[cfg(windows)]
async fn run_event_loop<F, K, U>(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    heartbeat_timeout: Duration,
    attempt: u32,
    mut on_stdout: F,
    mut on_timeout_kill: K,
    mut on_unhealthy: U,
) where
    F: FnMut(&[u8]) -> bool,
    K: FnMut(),
    U: FnMut(),
{
    let mut last_heartbeat = Instant::now();
    let mut killed = false;
    loop {
        let deadline = last_heartbeat + heartbeat_timeout;
        tokio::select! {
            maybe_event = rx.recv() => {
                let Some(event) = maybe_event else { break };
                match event {
                    CommandEvent::Stdout(bytes) => {
                        if on_stdout(&bytes) {
                            last_heartbeat = Instant::now();
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        tracing::debug!(line = %String::from_utf8_lossy(&bytes), "sidecar stderr");
                    }
                    CommandEvent::Error(msg) => {
                        // Transient stream error; the child may still be alive.
                        // Log and keep reading until we see Terminated (or the
                        // stream closes on its own).
                        tracing::error!(error = %msg, attempt, "sidecar command stream error");
                    }
                    CommandEvent::Terminated(payload) => {
                        tracing::warn!(code = ?payload.code, attempt, "sidecar terminated");
                        break;
                    }
                    // `CommandEvent` is `#[non_exhaustive]` upstream. Any future
                    // variant should at least surface at trace level instead of
                    // silently disappearing.
                    _ => {
                        tracing::trace!(attempt, "unhandled sidecar command event variant");
                    }
                }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)), if !killed => {
                let gap_ms = last_heartbeat.elapsed().as_millis() as u64;
                tracing::error!(
                    attempt,
                    gap_ms,
                    timeout_ms = heartbeat_timeout.as_millis() as u64,
                    "heartbeat timeout; killing sidecar to force respawn"
                );
                on_unhealthy();
                on_timeout_kill();
                killed = true;
            }
        }
    }
}

/// The signed-in user, whose own channel is joined when no tab is open.
#[cfg(windows)]
struct Identity {
    user_id: String,
    login: String,
}

/// What a join needs to import the channel's backlog.
#[cfg(windows)]
struct BacklogDeps<R: Runtime> {
    app: AppHandle<R>,
    history: History,
    emote_index: Arc<EmoteIndexes>,
}

/// Delay before retrying a channel connect whose token load failed.
#[cfg(windows)]
const CHANNEL_RETRY_DELAY: Duration = Duration::from_secs(5);

#[cfg(windows)]
async fn channel_switch_loop<R: Runtime>(
    channels: watch::Receiver<ChannelSelection>,
    own_user_id: String,
    own_login: String,
    auth: Arc<AuthManager>,
    sender: SidecarCommandSender,
    backlog: BacklogDeps<R>,
) {
    let BacklogDeps {
        app,
        history,
        emote_index,
    } = backlog;
    let http = auth.http_client().clone();
    channel_switch_loop_inner(
        channels,
        Identity {
            user_id: own_user_id,
            login: own_login,
        },
        CHANNEL_RETRY_DELAY,
        || {
            let auth = Arc::clone(&auth);
            async move { auth.load_or_refresh().await.map(|t| t.access_token) }
        },
        |line| sender.write_raw(line),
        |channel| {
            let Some(channel) = channel else { return };
            if !app.state::<BacklogSetting>().is_enabled() {
                return;
            }
            // Subscribing here, before the sidecar can answer the connect,
            // guarantees this channel's bundle arrives after the receiver.
            let bundle = app.state::<EmoteBundleState>().subscribe();
            history.begin_import(channel.id.clone());
            tauri::async_runtime::spawn(backlog::import(
                http.clone(),
                channel.clone(),
                history.clone(),
                emote_index.clone(),
                bundle,
            ));
        },
        |channel_id| {
            emote_index.remove(channel_id);
            app.state::<EmoteBundleState>().remove(channel_id);
        },
    )
    .await;
}

/// Keeps the sidecar joined to exactly the selected channels. An empty
/// selection means the signed-in user's own channel. `on_join` runs right
/// after each connect is written, `on_leave` after each disconnect, so the
/// caller can set up and tear down per-channel state. Returns when the
/// sidecar stdin is gone (write fails) or the channel selector has been
/// dropped.
#[cfg(windows)]
async fn channel_switch_loop_inner<T, Fut, W, J, L>(
    mut channels: watch::Receiver<ChannelSelection>,
    me: Identity,
    retry_delay: Duration,
    mut fetch_token: T,
    mut write: W,
    mut on_join: J,
    mut on_leave: L,
) where
    T: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<String, AuthError>>,
    W: FnMut(&[u8]) -> bool,
    J: FnMut(Option<&Channel>),
    L: FnMut(&str),
{
    let Identity {
        user_id: own_user_id,
        login: own_login,
    } = me;
    // Join counter of every live connection by broadcaster id; a bumped
    // counter turns a rejoin of the same channel into a leave and a join.
    let mut connected: HashMap<String, u64> = HashMap::new();
    loop {
        let desired: Vec<(String, u64, Option<Channel>)> = {
            let sel = channels.borrow_and_update();
            if sel.joined.is_empty() {
                vec![(own_user_id.clone(), 0, None)]
            } else {
                sel.joined
                    .iter()
                    .map(|j| (j.channel.id.clone(), j.join, Some(j.channel.clone())))
                    .collect()
            }
        };
        let mut leaving: Vec<String> = connected
            .iter()
            .filter(|(id, join)| !desired.iter().any(|(d, j, _)| d == *id && j == *join))
            .map(|(id, _)| id.clone())
            .collect();
        leaving.sort();
        let joining: Vec<&(String, u64, Option<Channel>)> = desired
            .iter()
            .filter(|(id, join, _)| connected.get(id) != Some(join))
            .collect();

        if !leaving.is_empty() || !joining.is_empty() {
            let access_token = if joining.is_empty() {
                String::new()
            } else {
                match fetch_token().await {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::warn!(error = %e, "token load failed before channel connect; retrying");
                        tokio::time::sleep(retry_delay).await;
                        continue;
                    }
                }
            };
            for id in leaving {
                let line = match build_twitch_disconnect_line(&id) {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::error!(error = %e, "failed to serialize twitch_disconnect");
                        return;
                    }
                };
                if !write(&line) {
                    return;
                }
                tracing::info!(broadcaster = %id, "sent twitch_disconnect");
                connected.remove(&id);
                on_leave(&id);
            }
            for (id, join, channel) in joining {
                let creds = TwitchCreds {
                    client_id: TWITCH_CLIENT_ID.to_owned(),
                    access_token: access_token.clone(),
                    broadcaster_id: id.clone(),
                    channel_login: channel
                        .as_ref()
                        .map_or_else(|| own_login.clone(), |c| c.login.clone()),
                    user_id: own_user_id.clone(),
                };
                let line = match build_twitch_connect_line(&creds) {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::error!(error = %e, "failed to serialize twitch_connect");
                        return;
                    }
                };
                if !write(&line) {
                    return;
                }
                tracing::info!(broadcaster = %id, "sent twitch_connect");
                on_join(channel.as_ref());
                connected.insert(id.clone(), *join);
            }
        }

        if channels.changed().await.is_err() {
            return;
        }
    }
}

/// Check interval for proactive token refresh. Slightly shorter than the
/// 5-minute refresh threshold so we always refresh before the sidecar's
/// token actually expires.
#[cfg(windows)]
const TOKEN_CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60);

/// Periodically checks if the Twitch access token is near expiry and
/// pushes a fresh one to the running sidecar. Designed to be spawned as
/// a tokio task and aborted when the sidecar iteration ends.
#[cfg(windows)]
async fn token_refresh_loop(
    auth: Arc<AuthManager>,
    granted: Vec<String>,
    signed_in: Arc<Notify>,
    sender: SidecarCommandSender,
) {
    token_refresh_loop_inner(auth, TOKEN_CHECK_INTERVAL, granted, signed_in, |line| {
        sender.write_raw(line)
    })
    .await;
}

/// Inner loop extracted so tests can inject a fake write callback and a
/// shorter interval without needing a real `CommandChild`. `granted` is
/// the scope set the sidecar's subscriptions were made with; a token with
/// a different set goes out as `twitch_resubscribe` instead of a plain
/// refresh.
#[cfg(windows)]
async fn token_refresh_loop_inner<W>(
    auth: Arc<AuthManager>,
    period: Duration,
    granted: Vec<String>,
    signed_in: Arc<Notify>,
    mut write: W,
) where
    W: FnMut(&[u8]) -> bool,
{
    let mut interval = tokio::time::interval(period);
    // The first tick fires immediately; skip it since we just loaded
    // a fresh token at sidecar spawn.
    interval.tick().await;

    let mut last_token = String::new();
    let mut granted: BTreeSet<String> = granted.into_iter().collect();

    loop {
        tokio::select! {
            _ = interval.tick() => {}
            () = signed_in.notified() => {}
        }

        let tokens = match auth.load_or_refresh().await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "proactive token refresh failed");
                continue;
            }
        };

        let scopes: BTreeSet<String> = tokens.scopes.iter().cloned().collect();
        let regranted = scopes != granted;
        if !regranted && tokens.access_token == last_token {
            tracing::debug!("token unchanged, skipping refresh send");
            continue;
        }

        let built = if regranted {
            build_twitch_resubscribe_line(&tokens.access_token)
        } else {
            build_token_refresh_line(&tokens.access_token)
        };
        let line = match built {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(error = %e, "failed to serialize token command");
                continue;
            }
        };

        if write(&line) {
            last_token = tokens.access_token;
            if regranted {
                granted = scopes;
                tracing::info!("granted scopes changed; sidecar resubscribing");
            } else {
                tracing::info!("proactive token refresh sent to sidecar");
            }
        } else {
            tracing::debug!("sidecar gone before token refresh could be sent");
            break;
        }
    }
}

#[cfg(windows)]
fn run_drain_loop<R: Runtime>(
    mut reader: RingBufReader,
    app: AppHandle<R>,
    shutdown: Arc<AtomicBool>,
    emote_index: Arc<EmoteIndexes>,
    arrival_seq: Arc<AtomicU64>,
    history: &History,
) {
    let timeout_ms: u32 = SIGNAL_WAIT_TIMEOUT
        .as_millis()
        .try_into()
        .expect("signal wait timeout fits in u32 ms");
    let mut batch: Vec<UnifiedMessage> = Vec::with_capacity(64);
    let mut events: Vec<ChatEvent> = Vec::new();
    // Local mirror of the shared atomic; loaded once, written back after
    // each emit. Only one drain loop runs at a time across the
    // supervisor lifetime (each respawn awaits the prior `run_once`),
    // so there are no concurrent writers and Relaxed ordering is
    // sufficient for the load/store pair.
    let mut next_seq: u64 = arrival_seq.load(Ordering::Relaxed);

    loop {
        if shutdown.load(Ordering::Acquire) {
            drain_and_emit(
                &mut reader,
                &app,
                &mut batch,
                &mut events,
                &emote_index,
                &mut next_seq,
                history,
            );
            arrival_seq.store(next_seq, Ordering::Relaxed);
            return;
        }
        match reader.wait_for_signal(timeout_ms) {
            Ok(WaitOutcome::Signaled) | Ok(WaitOutcome::TimedOut) => {}
            Err(e) => {
                tracing::error!(error = %e, "wait_for_signal failed, drain loop exiting");
                arrival_seq.store(next_seq, Ordering::Relaxed);
                return;
            }
        }
        drain_and_emit(
            &mut reader,
            &app,
            &mut batch,
            &mut events,
            &emote_index,
            &mut next_seq,
            history,
        );
        arrival_seq.store(next_seq, Ordering::Relaxed);
    }
}

#[cfg(windows)]
fn drain_and_emit<R: Runtime>(
    reader: &mut RingBufReader,
    app: &AppHandle<R>,
    batch: &mut Vec<UnifiedMessage>,
    events: &mut Vec<ChatEvent>,
    emote_index: &EmoteIndexes,
    next_seq: &mut u64,
    history: &History,
) {
    let raw = reader.drain();
    if raw.is_empty() {
        return;
    }
    batch.clear();
    events.clear();
    parse_batch(&raw, batch, events, emote_index);
    if !batch.is_empty() {
        assign_arrival_seqs(batch, next_seq);
        history.store(batch);
        if let Err(e) = app.emit("chat_messages", &*batch) {
            tracing::error!(error = %e, "failed to emit chat_messages");
        }
    }
    if !events.is_empty() {
        history.apply(events);
        if let Err(e) = app.emit("chat_events", &*events) {
            tracing::error!(error = %e, "failed to emit chat_events");
        }
    }
}

/// Processes one line of sidecar stdout. Tauri's shell plugin (in
/// non-raw mode, which is our default) emits one [`CommandEvent::Stdout`]
/// per `\n`-terminated line written by the child, with the trailing
/// newline stripped, so a partial line never reaches us. The split-on-`\n`
/// here is defensive: if the plugin ever changes that contract or the
/// sidecar buffers multiple JSON objects per write, each object still
/// parses independently. Empty pieces (trailing newline, blank lines) are
/// skipped.
///
/// Returns `true` if at least one heartbeat was observed in this batch,
/// which lets the supervisor reset the heartbeat-timeout deadline without
/// re-parsing each line.
#[cfg(windows)]
fn handle_sidecar_stdout<R: Runtime>(
    bytes: &[u8],
    app: &AppHandle<R>,
    emote_index: &Arc<EmoteIndexes>,
    sender: &SidecarCommandSender,
) -> bool {
    scan_sidecar_stdout(
        bytes,
        |bundle| apply_emote_bundle(bundle, app, emote_index),
        |result| sender.complete_send_chat(result),
        |banned| {
            if let Err(e) = app.emit("chat_banned", &banned) {
                tracing::warn!(error = %e, "failed to emit chat_banned");
            }
        },
        |first| {
            // Saved with the history so the mark is still there after a
            // reload or restart, then shown right away.
            app.state::<History>()
                .mark_first(first.channel_id.clone(), first.message_id.clone());
            if let Err(e) = app.emit("first_message", &first) {
                tracing::warn!(error = %e, "failed to emit first_message");
            }
        },
        |event| apply_paint_event(event, app),
    )
}

/// Records a 7TV paint or entitlement and tells the webview what changed:
/// `seventv_paint` for a new or edited paint, `seventv_paint_users` for
/// users whose paint changed.
#[cfg(windows)]
fn apply_paint_event<R: Runtime>(event: PaintEvent, app: &AppHandle<R>) {
    let state = app.state::<PaintState>();
    match event {
        PaintEvent::Paint(paint) => {
            if state.add_paint(&paint) {
                if let Err(e) = app.emit("seventv_paint", paint.as_ref()) {
                    tracing::warn!(error = %e, "failed to emit seventv_paint");
                }
            }
        }
        PaintEvent::Entitlement(entitlement) => {
            let changed = state.apply(entitlement);
            if !changed.is_empty() {
                if let Err(e) = app.emit("seventv_paint_users", &changed) {
                    tracing::warn!(error = %e, "failed to emit seventv_paint_users");
                }
            }
        }
    }
}

/// Pure scan-and-dispatch core of [`handle_sidecar_stdout`]. Splits the
/// batch on newlines, parses each non-empty piece via
/// [`parse_sidecar_event`], returns `true` if any line was a heartbeat,
/// and invokes `on_bundle`/`on_send_result`/`on_banned`/`on_first`/`on_paint`
/// for the corresponding variants. Factored out so it can be unit-tested
/// without a Tauri runtime (the AppHandle-dependent work happens inside the
/// closures).
fn scan_sidecar_stdout<F, G, H, I, P>(
    bytes: &[u8],
    mut on_bundle: F,
    mut on_send_result: G,
    mut on_banned: H,
    mut on_first: I,
    mut on_paint: P,
) -> bool
where
    F: FnMut(Box<crate::emote_index::EmoteBundle>),
    G: FnMut(crate::host::SendChatResult),
    H: FnMut(crate::host::ChatBanned),
    I: FnMut(crate::host::FirstMessage),
    P: FnMut(crate::seventv_paints::PaintEvent),
{
    let mut saw_heartbeat = false;
    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        match parse_sidecar_event(line) {
            SidecarEvent::Heartbeat => saw_heartbeat = true,
            SidecarEvent::EmoteBundle(bundle) => on_bundle(bundle),
            SidecarEvent::SendChatResult(r) => on_send_result(r),
            SidecarEvent::ModActionResult(r) => on_send_result(r),
            SidecarEvent::ChatBanned(b) => on_banned(b),
            SidecarEvent::FirstMessage(f) => on_first(f),
            SidecarEvent::SevenTvPaint(p) => on_paint(p),
            SidecarEvent::Other(t) => {
                tracing::debug!(msg_type = %t, "unhandled sidecar control message");
            }
            SidecarEvent::Invalid => {
                tracing::debug!(line = %String::from_utf8_lossy(line), "sidecar stdout (non-control)");
            }
        }
    }
    saw_heartbeat
}

/// Swaps a fresh [`EmoteBundle`] into the supervisor's [`EmoteIndexes`] and
/// forwards a clone to the frontend. The frontend gets the full bundle
/// (emotes + badges + per-provider errors) so it can render emote and
/// badge images and surface partial-failure state without a second round
/// trip; only the emote sets feed [`EmoteIndexes::load_bundle`], which is
/// lock-free for readers. Badges are resolved entirely on the frontend
/// from the same bundle — keeping the message hot path allocation-free.
#[cfg(windows)]
fn apply_emote_bundle<R: Runtime>(
    bundle: Box<EmoteBundle>,
    app: &AppHandle<R>,
    emote_index: &Arc<EmoteIndexes>,
) {
    let total = bundle.total_emotes();
    // Frontend needs the full bundle to render URLs; cloning is cheap
    // compared to the network fetch that produced it and happens at most
    // once per channel join.
    if let Err(e) = app.emit("emote_bundle", bundle.as_ref()) {
        tracing::error!(error = %e, "failed to emit emote_bundle");
    }
    // The index is loaded before the state announces the bundle, so a
    // backlog import woken by the announcement scans against it.
    emote_index.load_bundle(bundle.as_ref().clone());
    app.state::<EmoteBundleState>().set(*bundle);
    tracing::info!(total_emotes = total, "emote index rebuilt");
}

/// Every joined channel's bundle, so a tab switch or a webview reload can
/// ask for the right emotes and badges instead of waiting for the next
/// join. Also announces each arrival with its channel so a backlog import
/// can wait for its own channel's emotes.
pub struct EmoteBundleState {
    bundles: Mutex<HashMap<String, Arc<EmoteBundle>>>,
    arrivals: watch::Sender<BundleArrival>,
}

/// A counter plus the broadcaster whose bundle just arrived; the counter
/// makes every arrival a change even for the same channel.
pub type BundleArrival = (u64, String);

impl Default for EmoteBundleState {
    fn default() -> Self {
        Self {
            bundles: Mutex::new(HashMap::new()),
            arrivals: watch::channel((0, String::new())).0,
        }
    }
}

impl EmoteBundleState {
    pub fn set(&self, bundle: EmoteBundle) {
        let channel = bundle.broadcaster_id.clone();
        self.bundles
            .lock()
            .expect("emote bundle state poisoned")
            .insert(channel.clone(), Arc::new(bundle));
        self.arrivals.send_modify(|a| {
            a.0 += 1;
            a.1 = channel;
        });
    }

    pub fn current(&self, channel_id: &str) -> Option<Arc<EmoteBundle>> {
        self.bundles
            .lock()
            .expect("emote bundle state poisoned")
            .get(channel_id)
            .cloned()
    }

    pub fn remove(&self, channel_id: &str) {
        self.bundles
            .lock()
            .expect("emote bundle state poisoned")
            .remove(channel_id);
    }

    /// A receiver that reports every bundle arriving after this call.
    pub fn subscribe(&self) -> watch::Receiver<BundleArrival> {
        self.arrivals.subscribe()
    }
}

#[tauri::command]
pub fn current_emote_bundle(
    state: State<'_, EmoteBundleState>,
    channel_id: String,
) -> Option<EmoteBundle> {
    state.current(&channel_id).map(|b| (*b).clone())
}

fn emit_status<R: Runtime>(
    app: &AppHandle<R>,
    state: &'static str,
    attempt: u32,
    backoff_ms: Option<u64>,
) {
    let status = SidecarStatus {
        state,
        attempt,
        backoff_ms,
    };
    app.state::<SidecarStatusState>().set(status.clone());
    if let Err(e) = app.emit("sidecar_status", &status) {
        tracing::warn!(error = %e, state, "failed to emit sidecar_status");
    }
}

/// The latest status, kept so a webview that mounts after the sidecar
/// already connected (a reload, or a slow first paint) can read it instead
/// of waiting for the next transition.
#[derive(Default)]
pub struct SidecarStatusState(Mutex<Option<SidecarStatus>>);

impl SidecarStatusState {
    pub fn set(&self, status: SidecarStatus) {
        *self.0.lock().expect("sidecar status poisoned") = Some(status);
    }

    pub fn current(&self) -> Option<SidecarStatus> {
        self.0.lock().expect("sidecar status poisoned").clone()
    }
}

#[tauri::command]
pub fn current_sidecar_status(state: State<'_, SidecarStatusState>) -> Option<SidecarStatus> {
    state.current()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    mod channel_switch {
        use super::*;
        use crate::twitch_channel::JoinedChannel;
        use std::cell::RefCell;
        use std::rc::Rc;

        fn chan(id: &str) -> Channel {
            Channel {
                id: id.into(),
                login: id.into(),
                display_name: id.into(),
                profile_image_url: String::new(),
            }
        }

        fn sel(channel: Option<Channel>) -> ChannelSelection {
            tabs(channel.into_iter().collect())
        }

        fn me() -> Identity {
            Identity {
                user_id: "me".into(),
                login: "me".into(),
            }
        }

        // Yields until the loop has written `n` commands, so a test never
        // depends on how the scheduler interleaves the two futures.
        async fn settle(written: &Rc<RefCell<Vec<Vec<u8>>>>, n: usize) {
            for _ in 0..100 {
                if written.borrow().len() >= n {
                    return;
                }
                tokio::task::yield_now().await;
            }
            panic!("loop never wrote {n} commands");
        }

        fn tabs(channels: Vec<Channel>) -> ChannelSelection {
            ChannelSelection {
                focused: channels.last().cloned(),
                joined: channels
                    .into_iter()
                    .map(|channel| JoinedChannel { channel, join: 0 })
                    .collect(),
            }
        }

        fn cmds(lines: &[Vec<u8>]) -> Vec<(String, String)> {
            lines
                .iter()
                .map(|l| {
                    let v: serde_json::Value = serde_json::from_slice(l).unwrap();
                    (
                        v["cmd"].as_str().unwrap().to_owned(),
                        v["broadcaster_id"].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        }

        type Written = Rc<RefCell<Vec<Vec<u8>>>>;

        fn recorder() -> (Written, impl FnMut(&[u8]) -> bool) {
            let written = Rc::new(RefCell::new(Vec::new()));
            let w = Rc::clone(&written);
            (written, move |line: &[u8]| {
                w.borrow_mut().push(line.to_vec());
                true
            })
        }

        #[tokio::test]
        async fn connects_to_own_channel_when_nothing_selected() {
            let (tx, rx) = watch::channel(sel(None));
            let (written, write) = recorder();
            drop(tx);
            channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                write,
                |_| {},
                |_| {},
            )
            .await;
            assert_eq!(
                cmds(&written.borrow()),
                vec![("twitch_connect".into(), "me".into())]
            );
        }

        #[tokio::test]
        async fn switches_with_disconnect_then_connect_and_ignores_same_channel() {
            let (tx, rx) = watch::channel(sel(None));
            let (written, write) = recorder();
            let loop_fut = channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                write,
                |_| {},
                |_| {},
            );
            let driver = async {
                tokio::task::yield_now().await;
                tx.send(sel(Some(chan("a")))).unwrap();
                tokio::task::yield_now().await;
                tx.send(sel(Some(chan("a")))).unwrap();
                tokio::task::yield_now().await;
                tx.send(sel(Some(chan("b")))).unwrap();
                tokio::task::yield_now().await;
                drop(tx);
            };
            tokio::join!(loop_fut, driver);
            assert_eq!(
                cmds(&written.borrow()),
                vec![
                    ("twitch_connect".into(), "me".into()),
                    ("twitch_disconnect".into(), "me".into()),
                    ("twitch_connect".into(), "a".into()),
                    ("twitch_disconnect".into(), "a".into()),
                    ("twitch_connect".into(), "b".into()),
                ]
            );
        }

        #[tokio::test]
        async fn join_hook_sees_the_selected_channel_on_each_connect() {
            let (tx, rx) = watch::channel(sel(Some(chan("a"))));
            let (_written, write) = recorder();
            let joined = Rc::new(RefCell::new(Vec::new()));
            let seen = joined.clone();
            let loop_fut = channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                write,
                move |c| seen.borrow_mut().push(c.map(|c| c.login.clone())),
                |_| {},
            );
            let driver = async {
                tokio::task::yield_now().await;
                tx.send(sel(None)).unwrap();
                tokio::task::yield_now().await;
                drop(tx);
            };
            tokio::join!(loop_fut, driver);
            assert_eq!(*joined.borrow(), vec![Some("a".to_owned()), None]);
        }

        #[tokio::test]
        async fn tabs_join_and_leave_as_the_set_changes() {
            let (tx, rx) = watch::channel(tabs(vec![chan("a"), chan("b")]));
            let (written, write) = recorder();
            let left = Rc::new(RefCell::new(Vec::new()));
            let seen = left.clone();
            let loop_fut = channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                write,
                |_| {},
                move |id| seen.borrow_mut().push(id.to_owned()),
            );
            let driver = async {
                settle(&written, 2).await;
                tx.send(tabs(vec![chan("b")])).unwrap();
                settle(&written, 3).await;
                tx.send(tabs(vec![chan("b"), chan("c")])).unwrap();
                settle(&written, 4).await;
                tx.send(tabs(vec![])).unwrap();
                settle(&written, 7).await;
                drop(tx);
            };
            tokio::join!(loop_fut, driver);
            assert_eq!(
                cmds(&written.borrow()),
                vec![
                    ("twitch_connect".into(), "a".into()),
                    ("twitch_connect".into(), "b".into()),
                    ("twitch_disconnect".into(), "a".into()),
                    ("twitch_connect".into(), "c".into()),
                    ("twitch_disconnect".into(), "b".into()),
                    ("twitch_disconnect".into(), "c".into()),
                    ("twitch_connect".into(), "me".into()),
                ]
            );
            assert_eq!(*left.borrow(), vec!["a".to_owned(), "b".into(), "c".into()]);
        }

        #[tokio::test]
        async fn rejoin_leaves_and_rejoins_the_same_channel() {
            let (tx, rx) = watch::channel(sel(Some(chan("a"))));
            let (written, write) = recorder();
            let loop_fut = channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                write,
                |_| {},
                |_| {},
            );
            let driver = async {
                tokio::task::yield_now().await;
                tx.send_modify(|s| s.joined[0].join += 1);
                tokio::task::yield_now().await;
                drop(tx);
            };
            tokio::join!(loop_fut, driver);
            assert_eq!(
                cmds(&written.borrow()),
                vec![
                    ("twitch_connect".into(), "a".into()),
                    ("twitch_disconnect".into(), "a".into()),
                    ("twitch_connect".into(), "a".into()),
                ]
            );
        }

        #[tokio::test]
        async fn connect_line_carries_token_and_self_user_id() {
            let (tx, rx) = watch::channel(sel(Some(chan("streamer"))));
            let (written, write) = recorder();
            drop(tx);
            channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                write,
                |_| {},
                |_| {},
            )
            .await;
            let v: serde_json::Value = serde_json::from_slice(&written.borrow()[0]).unwrap();
            assert_eq!(v["broadcaster_id"], "streamer");
            assert_eq!(v["user_id"], "me");
            assert_eq!(v["token"], "tok");
            assert_eq!(v["client_id"], TWITCH_CLIENT_ID);
        }

        #[tokio::test]
        async fn exits_when_sidecar_stdin_is_gone() {
            let (_tx, rx) = watch::channel(sel(None));
            channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || async { Ok("tok".to_owned()) },
                |_line| false,
                |_| {},
                |_| {},
            )
            .await;
        }

        #[tokio::test]
        async fn retries_connect_after_token_failure() {
            let (tx, rx) = watch::channel(sel(None));
            let (written, write) = recorder();
            let calls = RefCell::new(0u32);
            drop(tx);
            channel_switch_loop_inner(
                rx,
                me(),
                Duration::from_millis(1),
                || {
                    *calls.borrow_mut() += 1;
                    let fail = *calls.borrow() == 1;
                    async move {
                        if fail {
                            Err(AuthError::OAuth("boom".into()))
                        } else {
                            Ok("tok".to_owned())
                        }
                    }
                },
                write,
                |_| {},
                |_| {},
            )
            .await;
            assert_eq!(*calls.borrow(), 2);
            assert_eq!(
                cmds(&written.borrow()),
                vec![("twitch_connect".into(), "me".into())]
            );
        }
    }

    #[test]
    fn default_config_matches_spec() {
        let cfg = SupervisorConfig::default();
        assert_eq!(cfg.initial_backoff, Duration::from_millis(250));
        assert_eq!(cfg.max_backoff, Duration::from_secs(30));
        assert_eq!(cfg.healthy_threshold, Duration::from_secs(60));
        // `docs/stability.md` §Sidecar Health: 3 missed heartbeats at
        // 1 s interval triggers respawn.
        assert_eq!(cfg.heartbeat_timeout, Duration::from_secs(3));
    }

    #[test]
    fn backoff_doubles_until_max() {
        let cfg = SupervisorConfig::default();
        let ladder = [
            (Duration::from_millis(250), Duration::from_millis(500)),
            (Duration::from_millis(500), Duration::from_secs(1)),
            (Duration::from_secs(1), Duration::from_secs(2)),
            (Duration::from_secs(2), Duration::from_secs(4)),
            (Duration::from_secs(4), Duration::from_secs(8)),
            (Duration::from_secs(8), Duration::from_secs(16)),
            (Duration::from_secs(16), Duration::from_secs(30)),
            (Duration::from_secs(30), Duration::from_secs(30)),
        ];
        for (input, expected) in ladder {
            assert_eq!(next_backoff(input, &cfg), expected, "input {input:?}");
        }
    }

    #[test]
    fn backoff_saturates_on_huge_input() {
        let cfg = SupervisorConfig::default();
        assert_eq!(next_backoff(Duration::MAX, &cfg), cfg.max_backoff);
    }

    #[test]
    fn sidecar_status_serializes_without_backoff_ms_when_none() {
        let status = SidecarStatus {
            state: "running",
            attempt: 3,
            backoff_ms: None,
        };
        let v: serde_json::Value = serde_json::to_value(&status).unwrap();
        assert_eq!(v["state"], "running");
        assert_eq!(v["attempt"], 3);
        assert!(v.get("backoff_ms").is_none());
    }

    #[test]
    fn sidecar_status_serializes_backoff_ms_when_some() {
        let status = SidecarStatus {
            state: "backoff",
            attempt: 7,
            backoff_ms: Some(4000),
        };
        let v: serde_json::Value = serde_json::to_value(&status).unwrap();
        assert_eq!(v["state"], "backoff");
        assert_eq!(v["backoff_ms"], 4000);
    }

    const VALID_EMOTE_BUNDLE_LINE: &[u8] = br#"{"type":"emote_bundle","payload":{"twitch_global_emotes":{"provider":"twitch","scope":"global","emotes":[{"id":"1","code":"Kappa","provider":"twitch","url_1x":"https://t/1"}]},"twitch_channel_emotes":{"provider":"twitch","scope":"channel","emotes":[]},"twitch_global_badges":{"scope":"global","badges":[]},"twitch_channel_badges":{"scope":"channel","badges":[]},"seventv_global":{"provider":"7tv","scope":"global","emotes":[]},"seventv_channel":{"provider":"7tv","scope":"channel","emotes":[]},"bttv_global":{"provider":"bttv","scope":"global","emotes":[]},"bttv_channel":{"provider":"bttv","scope":"channel","emotes":[]},"ffz_global":{"provider":"ffz","scope":"global","emotes":[]},"ffz_channel":{"provider":"ffz","scope":"channel","emotes":[]},"youtube_badges":{"scope":"global","badges":[{"set":"youtube/owner","version":"1","title":"Channel Owner","url_1x":"data:image/svg+xml,yt"}]},"kick_badges":{"scope":"global","badges":[{"set":"kick/broadcaster","version":"1","title":"Broadcaster","url_1x":"data:image/svg+xml,kick"}]}}}"#;

    #[test]
    fn scan_sidecar_stdout_returns_false_on_empty_input() {
        assert!(!scan_sidecar_stdout(
            b"",
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint")
        ));
        assert!(!scan_sidecar_stdout(
            b"\n\n\n",
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint")
        ));
    }

    #[test]
    fn scan_sidecar_stdout_detects_single_heartbeat() {
        let line = br#"{"type":"heartbeat","payload":{"ts_ms":1,"counter":1}}"#;
        assert!(scan_sidecar_stdout(
            line,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint")
        ));
    }

    #[test]
    fn scan_sidecar_stdout_detects_heartbeat_in_multi_line_batch() {
        let mut batch = Vec::new();
        batch.extend_from_slice(b"garbage line\n");
        batch.extend_from_slice(br#"{"type":"future_thing","payload":{}}"#);
        batch.push(b'\n');
        batch.extend_from_slice(br#"{"type":"heartbeat","payload":{"ts_ms":1,"counter":1}}"#);
        batch.push(b'\n');
        assert!(scan_sidecar_stdout(
            &batch,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint")
        ));
    }

    #[test]
    fn scan_sidecar_stdout_reports_false_when_only_non_heartbeat_events() {
        let mut batch = Vec::new();
        batch.extend_from_slice(b"not json\n");
        batch.extend_from_slice(br#"{"type":"future_thing","payload":{}}"#);
        assert!(!scan_sidecar_stdout(
            &batch,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint")
        ));
    }

    #[test]
    fn scan_sidecar_stdout_dispatches_emote_bundle_and_tracks_heartbeat() {
        let mut batch = Vec::new();
        batch.extend_from_slice(VALID_EMOTE_BUNDLE_LINE);
        batch.push(b'\n');
        batch.extend_from_slice(br#"{"type":"heartbeat","payload":{"ts_ms":2,"counter":2}}"#);

        let mut bundles = 0_usize;
        let saw_heartbeat = scan_sidecar_stdout(
            &batch,
            |bundle| {
                assert_eq!(bundle.total_emotes(), 1);
                bundles += 1;
            },
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint"),
        );

        assert!(saw_heartbeat);
        assert_eq!(bundles, 1);
    }

    #[test]
    fn scan_sidecar_stdout_skips_empty_segments_between_newlines() {
        let mut batch = Vec::new();
        batch.extend_from_slice(b"\n\n");
        batch.extend_from_slice(br#"{"type":"heartbeat","payload":{"ts_ms":3,"counter":3}}"#);
        batch.extend_from_slice(b"\n\n");
        assert!(scan_sidecar_stdout(
            &batch,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint")
        ));
    }

    #[test]
    fn scan_sidecar_stdout_dispatches_send_chat_result() {
        let line = br#"{"type":"send_chat_result","payload":{"request_id":7,"ok":true,"message_id":"m1"}}"#;
        let mut got = None;
        let saw_heartbeat = scan_sidecar_stdout(
            line,
            |_| panic!("no bundle"),
            |r| got = Some(r),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |_| panic!("no paint"),
        );
        assert!(!saw_heartbeat);
        let r = got.expect("result dispatched");
        assert_eq!(r.request_id, 7);
        assert!(r.ok);
        assert_eq!(r.message_id, "m1");
    }

    #[test]
    fn scan_sidecar_stdout_dispatches_chat_banned() {
        let line = br#"{"type":"chat_banned","payload":{"broadcaster_id":"9","detail":"chat_user_banned"}}"#;
        let mut got = None;
        scan_sidecar_stdout(
            line,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |b| got = Some(b),
            |_| panic!("no first"),
            |_| panic!("no paint"),
        );
        assert_eq!(got.expect("ban dispatched").broadcaster_id, "9");
    }

    #[test]
    fn scan_sidecar_stdout_dispatches_first_message() {
        let line = br#"{"type":"first_message","payload":{"channel_id":"9","message_id":"m1"}}"#;
        let mut got = None;
        scan_sidecar_stdout(
            line,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |f| got = Some(f),
            |_| panic!("no paint"),
        );
        let f = got.expect("first message dispatched");
        assert_eq!(f.channel_id, "9");
        assert_eq!(f.message_id, "m1");
    }

    #[test]
    fn scan_sidecar_stdout_dispatches_seventv_paints() {
        let batch = br#"{"type":"seventv_entitlement","payload":{"action":"delete","user_id":"1","seventv_id":"s","paint_id":"p"}}
{"type":"seventv_paint","payload":{"id":"p","function":"URL","image_url":"https://cdn.7tv.app/paint/p/layer/l/1x.webp"}}"#;
        let mut got = Vec::new();
        scan_sidecar_stdout(
            batch,
            |_| panic!("no bundle"),
            |_| panic!("no result"),
            |_| panic!("no ban"),
            |_| panic!("no first"),
            |p| got.push(p),
        );
        assert!(matches!(
            got.as_slice(),
            [
                crate::seventv_paints::PaintEvent::Entitlement(_),
                crate::seventv_paints::PaintEvent::Paint(_)
            ]
        ));
    }

    // -- run_event_loop tests --------------------------------------------
    //
    // These drive the real event loop with an mpsc channel of
    // `CommandEvent`s under `tokio::time::pause()`, letting us assert the
    // heartbeat-respawn behaviour deterministically without a Tauri
    // runtime or a real child process.

    use std::cell::Cell;
    use std::rc::Rc;
    use tauri_plugin_shell::process::TerminatedPayload;
    use tokio::sync::mpsc;

    const HB_LINE: &[u8] = br#"{"type":"heartbeat","payload":{"ts_ms":1,"counter":1}}"#;

    #[derive(Default)]
    struct LoopProbe {
        stdout_calls: Rc<Cell<u32>>,
        kill_calls: Rc<Cell<u32>>,
        unhealthy_calls: Rc<Cell<u32>>,
    }

    impl LoopProbe {
        fn stdout(&self) -> u32 {
            self.stdout_calls.get()
        }
        fn kills(&self) -> u32 {
            self.kill_calls.get()
        }
        fn unhealthy(&self) -> u32 {
            self.unhealthy_calls.get()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn run_event_loop_exits_on_terminated_event() {
        let (tx, mut rx) = mpsc::channel::<CommandEvent>(4);
        let probe = LoopProbe::default();
        let stdout_calls = probe.stdout_calls.clone();
        let kill_calls = probe.kill_calls.clone();
        let unhealthy_calls = probe.unhealthy_calls.clone();

        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .await
        .unwrap();

        run_event_loop(
            &mut rx,
            Duration::from_secs(60),
            1,
            |_| {
                stdout_calls.set(stdout_calls.get() + 1);
                false
            },
            || kill_calls.set(kill_calls.get() + 1),
            || unhealthy_calls.set(unhealthy_calls.get() + 1),
        )
        .await;

        assert_eq!(probe.stdout(), 0);
        assert_eq!(probe.kills(), 0);
        assert_eq!(probe.unhealthy(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn run_event_loop_exits_when_stream_closes() {
        let (tx, mut rx) = mpsc::channel::<CommandEvent>(4);
        drop(tx); // close the channel immediately
        let probe = LoopProbe::default();
        let kill_calls = probe.kill_calls.clone();
        let unhealthy_calls = probe.unhealthy_calls.clone();

        run_event_loop(
            &mut rx,
            Duration::from_secs(60),
            1,
            |_| false,
            || kill_calls.set(kill_calls.get() + 1),
            || unhealthy_calls.set(unhealthy_calls.get() + 1),
        )
        .await;

        assert_eq!(probe.kills(), 0);
        assert_eq!(probe.unhealthy(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn run_event_loop_kills_on_heartbeat_timeout() {
        let (tx, mut rx) = mpsc::channel::<CommandEvent>(4);
        let probe = LoopProbe::default();
        let kill_calls = probe.kill_calls.clone();
        let unhealthy_calls = probe.unhealthy_calls.clone();

        // Drive the loop and feed a Terminated after the kill fires so it
        // exits cleanly. spawn_local isn't available on a single-threaded
        // runtime without LocalSet, so send the event synchronously after
        // `tokio::time::advance`.
        let timeout = Duration::from_secs(3);
        let loop_fut = run_event_loop(
            &mut rx,
            timeout,
            1,
            |_| false,
            || kill_calls.set(kill_calls.get() + 1),
            || unhealthy_calls.set(unhealthy_calls.get() + 1),
        );

        tokio::pin!(loop_fut);

        // Advance past the heartbeat deadline; the select! should pick the
        // timeout branch.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop exited before timeout"),
            _ = tokio::time::sleep(timeout + Duration::from_millis(100)) => {}
        }

        // Now close the stream so the loop exits.
        drop(tx);
        loop_fut.await;

        assert_eq!(probe.kills(), 1);
        assert_eq!(probe.unhealthy(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn run_event_loop_heartbeat_resets_deadline() {
        let (tx, mut rx) = mpsc::channel::<CommandEvent>(16);
        let probe = LoopProbe::default();
        let stdout_calls = probe.stdout_calls.clone();
        let kill_calls = probe.kill_calls.clone();

        let timeout = Duration::from_secs(3);

        // Pre-load two heartbeat batches, each followed by a ~2s pause.
        // After the second heartbeat we send Terminated so the loop exits
        // without the timeout branch ever firing.
        tx.send(CommandEvent::Stdout(HB_LINE.to_vec()))
            .await
            .unwrap();
        tx.send(CommandEvent::Stdout(HB_LINE.to_vec()))
            .await
            .unwrap();
        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .await
        .unwrap();

        run_event_loop(
            &mut rx,
            timeout,
            1,
            |bytes| {
                stdout_calls.set(stdout_calls.get() + 1);
                // Forward to the pure scanner so heartbeat detection is real.
                scan_sidecar_stdout(bytes, |_| {}, |_| {}, |_| {}, |_| {}, |_| {})
            },
            || kill_calls.set(kill_calls.get() + 1),
            || {},
        )
        .await;

        assert_eq!(probe.stdout(), 2);
        assert_eq!(probe.kills(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn run_event_loop_logs_stderr_and_error_without_affecting_state() {
        let (tx, mut rx) = mpsc::channel::<CommandEvent>(8);
        let probe = LoopProbe::default();
        let kill_calls = probe.kill_calls.clone();

        tx.send(CommandEvent::Stderr(b"some warning\n".to_vec()))
            .await
            .unwrap();
        tx.send(CommandEvent::Error("stream hiccup".into()))
            .await
            .unwrap();
        tx.send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(1),
            signal: None,
        }))
        .await
        .unwrap();

        run_event_loop(
            &mut rx,
            Duration::from_secs(60),
            7,
            |_| false,
            || kill_calls.set(kill_calls.get() + 1),
            || {},
        )
        .await;

        assert_eq!(probe.kills(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn run_event_loop_kills_at_most_once_across_multiple_deadlines() {
        let (tx, mut rx) = mpsc::channel::<CommandEvent>(4);
        let probe = LoopProbe::default();
        let kill_calls = probe.kill_calls.clone();
        let unhealthy_calls = probe.unhealthy_calls.clone();

        let timeout = Duration::from_millis(500);
        let loop_fut = run_event_loop(
            &mut rx,
            timeout,
            1,
            |_| false,
            || kill_calls.set(kill_calls.get() + 1),
            || unhealthy_calls.set(unhealthy_calls.get() + 1),
        );
        tokio::pin!(loop_fut);

        // Let the timeout branch fire once.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop exited before timeout"),
            _ = tokio::time::sleep(timeout * 2) => {}
        }

        // Advance another few timeouts with the stream still open; the
        // timeout branch is gated on `!killed` so it must not fire again.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop exited unexpectedly"),
            _ = tokio::time::sleep(timeout * 5) => {}
        }

        drop(tx);
        loop_fut.await;

        assert_eq!(probe.kills(), 1);
        assert_eq!(probe.unhealthy(), 1);
    }

    // -- token_refresh_loop tests ----------------------------------------

    use crate::twitch_auth::{AuthError, TokenStore, TwitchTokens};
    use std::sync::Mutex as StdMutex;

    fn far_future_tokens(access: &str) -> TwitchTokens {
        TwitchTokens {
            access_token: access.into(),
            refresh_token: "rt".into(),
            expires_at_ms: i64::MAX,
            scopes: vec![],
            user_id: "123".into(),
            login: "test".into(),
        }
    }

    /// Clone-able in-memory token store for tests that need to mutate
    /// the stored tokens after the `AuthManager` has been constructed.
    #[derive(Clone, Default)]
    struct SharedStore(Arc<StdMutex<Option<TwitchTokens>>>);

    impl crate::twitch_auth::TokenStore for SharedStore {
        fn load(&self) -> Result<Option<TwitchTokens>, AuthError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, tokens: &TwitchTokens) -> Result<(), AuthError> {
            *self.0.lock().unwrap() = Some(tokens.clone());
            Ok(())
        }
        fn delete(&self) -> Result<(), AuthError> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    fn make_auth(store: SharedStore) -> Arc<AuthManager> {
        Arc::new(AuthManager::builder("test_client_id").build(store, reqwest::Client::new()))
    }

    #[tokio::test(start_paused = true)]
    async fn token_refresh_loop_sends_on_new_token_then_breaks_on_write_fail() {
        let store = SharedStore::default();
        store.save(&far_future_tokens("tok_a")).unwrap();

        let auth = make_auth(store);
        let mut sent = Vec::new();

        // write returns false -> loop breaks after the first send attempt
        token_refresh_loop_inner(
            auth,
            Duration::from_millis(50),
            vec![],
            Arc::new(Notify::new()),
            |line| {
                sent.push(String::from_utf8_lossy(line).to_string());
                false
            },
        )
        .await;

        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains("tok_a"));
    }

    #[tokio::test(start_paused = true)]
    async fn token_refresh_loop_skips_unchanged_token() {
        let store = SharedStore::default();
        store.save(&far_future_tokens("tok_same")).unwrap();

        let auth = make_auth(store);
        let call_count = Rc::new(Cell::new(0u32));
        let cc = call_count.clone();

        let loop_fut = token_refresh_loop_inner(
            auth,
            Duration::from_millis(50),
            vec![],
            Arc::new(Notify::new()),
            move |_line| {
                cc.set(cc.get() + 1);
                true // write succeeds
            },
        );
        tokio::pin!(loop_fut);

        // Advance past 3 ticks: first tick is skipped, ticks 2-4 fire.
        // Tick 2 sees a new token (vs empty last_token) -> sends.
        // Ticks 3-4 see the same token -> skip.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }

        assert_eq!(call_count.get(), 1, "only the first tick should send");
    }

    #[tokio::test(start_paused = true)]
    async fn token_refresh_loop_sends_again_after_token_rotates() {
        let store = SharedStore::default();
        store.save(&far_future_tokens("tok_old")).unwrap();

        let auth = make_auth(store.clone());
        let sent = Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let s = sent.clone();

        let loop_fut = token_refresh_loop_inner(
            auth,
            Duration::from_millis(50),
            vec![],
            Arc::new(Notify::new()),
            move |line| {
                s.borrow_mut()
                    .push(String::from_utf8_lossy(line).to_string());
                true
            },
        );
        tokio::pin!(loop_fut);

        // Let the first real tick fire and send tok_old.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(60)) => {}
        }
        assert_eq!(sent.borrow().len(), 1);

        // Rotate the token in the store.
        store.save(&far_future_tokens("tok_new")).unwrap();

        // Advance past another tick.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(60)) => {}
        }

        let lines = sent.borrow();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("tok_old"));
        assert!(lines[1].contains("tok_new"));
    }

    #[tokio::test(start_paused = true)]
    async fn token_refresh_loop_continues_on_load_error() {
        let store = SharedStore::default();
        let auth = make_auth(store.clone());
        let call_count = Rc::new(Cell::new(0u32));
        let cc = call_count.clone();

        let loop_fut = token_refresh_loop_inner(
            auth,
            Duration::from_millis(50),
            vec![],
            Arc::new(Notify::new()),
            move |_| {
                cc.set(cc.get() + 1);
                true
            },
        );
        tokio::pin!(loop_fut);

        // Let a few error ticks pass. write should never be called.
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit on errors"),
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
        assert_eq!(call_count.get(), 0);

        // Now seed a token and let the next tick pick it up.
        store.save(&far_future_tokens("recovered")).unwrap();
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(60)) => {}
        }
        assert_eq!(call_count.get(), 1);
    }

    fn tokens_with_scopes(access: &str, scopes: &[&str]) -> TwitchTokens {
        TwitchTokens {
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            ..far_future_tokens(access)
        }
    }

    #[tokio::test(start_paused = true)]
    async fn sign_in_with_new_scopes_resubscribes_right_away() {
        let store = SharedStore::default();
        store
            .save(&tokens_with_scopes("tok_old", &["user:read:chat"]))
            .unwrap();
        let auth = make_auth(store.clone());
        let signed_in = Arc::new(Notify::new());
        let sent = Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let s = sent.clone();

        let loop_fut = token_refresh_loop_inner(
            auth,
            Duration::from_secs(3600),
            vec!["user:read:chat".into()],
            signed_in.clone(),
            move |line| {
                s.borrow_mut()
                    .push(String::from_utf8_lossy(line).to_string());
                true
            },
        );
        tokio::pin!(loop_fut);

        store
            .save(&tokens_with_scopes(
                "tok_new",
                &["moderator:read:chat_settings", "user:read:chat"],
            ))
            .unwrap();
        signed_in.notify_one();
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        {
            let lines = sent.borrow();
            assert_eq!(lines.len(), 1, "sent before the hourly tick");
            assert!(lines[0].contains("twitch_resubscribe"));
            assert!(lines[0].contains("tok_new"));
        }

        // The same grant signed in again is only a token change.
        store
            .save(&tokens_with_scopes(
                "tok_again",
                &["user:read:chat", "moderator:read:chat_settings"],
            ))
            .unwrap();
        signed_in.notify_one();
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        let lines = sent.borrow();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("token_refresh"));
        assert!(lines[1].contains("tok_again"));
    }

    #[tokio::test(start_paused = true)]
    async fn sign_in_with_the_same_grant_and_token_sends_nothing() {
        let store = SharedStore::default();
        store
            .save(&tokens_with_scopes("tok", &["user:read:chat"]))
            .unwrap();
        let auth = make_auth(store);
        let signed_in = Arc::new(Notify::new());
        let calls = Rc::new(Cell::new(0u32));
        let c = calls.clone();

        let loop_fut = token_refresh_loop_inner(
            auth,
            Duration::from_secs(3600),
            vec!["user:read:chat".into()],
            signed_in.clone(),
            move |_| {
                c.set(c.get() + 1);
                true
            },
        );
        tokio::pin!(loop_fut);

        // First wake sends the token once (the loop starts with none sent).
        signed_in.notify_one();
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        signed_in.notify_one();
        tokio::select! {
            _ = &mut loop_fut => panic!("loop should not exit"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        assert_eq!(calls.get(), 1);
    }
}
