//! Host-side helpers used by `lib.rs` to drive the sidecar: bootstrap
//! serialization, env-driven Twitch credentials, ring buffer batch parsing,
//! and the Windows handle inheritance toggles.
//!
//! The actual Tauri setup closure and the async drain loop live in `lib.rs`
//! because they are tightly coupled to the Tauri runtime and untestable
//! without a real app. Everything here is a pure function or a thin wrapper
//! around a platform API so the whole module stays unit-testable.

use std::time::Duration;

use serde::Serialize;

use crate::emote_index::{EmoteBundle, EmoteIndexes};
use crate::message::{
    compute_effective_ts, parse_kick_event, parse_twitch_envelope, parse_youtube_message,
    ChatEvent, TwitchItem, UnifiedMessage,
};
use crate::ringbuf::RawHandle;

/// Platform tag bytes prepended by the Go sidecar. Must match control.go.
const TAG_TWITCH: u8 = 0x01;
const TAG_KICK: u8 = 0x02;
const TAG_YOUTUBE: u8 = 0x03;
const TAG_TWITCH_IRC: u8 = 0x04;

/// Timeout for [`ringbuf::RingBufReader::wait_for_signal`] in the host drain
/// loop. In the happy path the sidecar signals the auto-reset event after
/// each ring write and the drain wakes immediately; this value only bounds
/// the worst-case latency of a missed signal.
///
/// 100 ms is a compromise between lost-signal recovery latency (still well
/// under the human-perceptible threshold) and idle CPU usage. An 8 ms timeout
/// would fire 125 times per second when the sidecar is quiet, burning wakes
/// for no reason; 100 ms fires 10 times per second, effectively free.
pub const SIGNAL_WAIT_TIMEOUT: Duration = Duration::from_millis(100);
pub const SIDECAR_BINARY: &str = "sidecar";

/// Twitch OAuth credentials sourced from environment variables for Phase 0 dev.
#[derive(Debug, Clone)]
pub struct TwitchCreds {
    pub client_id: String,
    pub access_token: String,
    pub broadcaster_id: String,
    /// Login of the channel to join, for the IRC fallback when EventSub
    /// refuses the chat.
    pub channel_login: String,
    pub user_id: String,
}

/// Parses a slice of raw ring-buffer payloads into [`UnifiedMessage`]s,
/// appending successful parses to the caller-owned `batch` scratch buffer.
/// The caller is responsible for clearing the scratch between drain ticks;
/// this function only appends.
///
/// Each payload is prefixed with a 1-byte platform tag (0x01 = Twitch,
/// 0x03 = YouTube). The tag determines which parser is invoked on the
/// remaining bytes.
///
/// Each successful parse is scanned for emotes against `emote_index`. The
/// scan is cheap when the index is empty (no automaton, early return) so
/// passing a fresh index is fine in tests and during the gap before
/// `emote_bundle` arrives. Badges stay as `{set_id, id}` pairs on the
/// wire; the frontend resolves them against its own bundle-derived store,
/// which keeps the hot path allocation-free and avoids copying the same
/// URL strings into every message.
///
/// The pure-data sort field [`UnifiedMessage::effective_ts`] is computed
/// here under the snap rule. The monotonic
/// [`UnifiedMessage::arrival_seq`] is left at zero; the drain loop owns
/// the counter and assigns it via [`crate::message::assign_arrival_seqs`] before emit.
///
/// Messages that fail to parse or that aren't chat notifications are dropped
/// with a log. Each parse is wrapped in `catch_unwind` so a panicking parser
/// cannot kill the drain loop (`docs/stability.md` §Rust Panic Handling).
/// Bytes of a rejected payload echoed to the debug log so the field that
/// broke the parser can be found without a packet capture.
const PARSE_FAILURE_SNIPPET: usize = 2048;

pub fn parse_batch(
    raw: &[Vec<u8>],
    batch: &mut Vec<UnifiedMessage>,
    events: &mut Vec<ChatEvent>,
    emote_index: &EmoteIndexes,
) {
    let indexes = emote_index.snapshot();
    for payload in raw {
        if payload.is_empty() {
            continue;
        }
        let tag = payload[0];
        let data = &payload[1..];
        let outcome = std::panic::catch_unwind(|| match tag {
            TAG_TWITCH => parse_twitch_envelope(data),
            TAG_KICK => parse_kick_event(data).map(|m| m.map(|m| TwitchItem::Message(Box::new(m)))),
            TAG_YOUTUBE => {
                parse_youtube_message(data).map(|m| m.map(|m| TwitchItem::Message(Box::new(m))))
            }
            TAG_TWITCH_IRC => Ok(parse_irc_line(data)),
            _ => {
                tracing::warn!(tag, "unknown platform tag, dropping message");
                Ok(None)
            }
        });
        match outcome {
            Ok(Ok(Some(TwitchItem::Message(msg)))) => {
                let mut msg = *msg;
                if let Some(index) = indexes.get(msg.channel_id.as_str()) {
                    index.scan_into(&msg.message_text, &mut msg.emote_spans);
                }
                msg.effective_ts = compute_effective_ts(msg.timestamp, msg.arrival_time);
                batch.push(msg);
            }
            Ok(Ok(Some(TwitchItem::Event(event)))) => events.push(event),
            Ok(Ok(None)) => {}
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "parse failed, dropping message");
                tracing::debug!(
                    payload = %String::from_utf8_lossy(&data[..data.len().min(PARSE_FAILURE_SNIPPET)]),
                    "unparsable payload"
                );
            }
            Err(_) => {
                tracing::error!("panic during envelope parse, dropping message");
            }
        }
    }
}

/// A raw IRC line from the sidecar's read-only fallback connection. The
/// line carries its own `room-id`, so nothing else is needed to route it.
fn parse_irc_line(data: &[u8]) -> Option<TwitchItem> {
    let line = std::str::from_utf8(data).ok()?;
    Some(match crate::twitch_irc::parse_line(line, None)? {
        crate::twitch_irc::IrcItem::Message { message, .. } => TwitchItem::Message(message),
        crate::twitch_irc::IrcItem::Event(event) => TwitchItem::Event(event),
    })
}

/// Serializes the bootstrap JSON line the Rust host writes to the sidecar's
/// stdin immediately after spawn. Includes the inheritable mapping HANDLE and
/// the auto-reset event HANDLE that the sidecar signals on each ring write.
pub fn build_bootstrap_line(
    handle: RawHandle,
    event_handle: RawHandle,
    size: usize,
) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Bootstrap {
        shm_handle: u64,
        shm_event_handle: u64,
        shm_size: u64,
    }
    let payload = Bootstrap {
        shm_handle: handle as u64,
        shm_event_handle: event_handle as u64,
        shm_size: size as u64,
    };
    let mut bytes = serde_json::to_vec(&payload)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Serializes a `twitch_disconnect` control command line for the sidecar.
pub fn build_twitch_disconnect_line(broadcaster_id: &str) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct DisconnectCmd<'a> {
        cmd: &'a str,
        broadcaster_id: &'a str,
    }
    let cmd = DisconnectCmd {
        cmd: "twitch_disconnect",
        broadcaster_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Serializes a `twitch_connect` control command line for the sidecar.
pub fn build_twitch_connect_line(creds: &TwitchCreds) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct ConnectCmd<'a> {
        cmd: &'a str,
        client_id: &'a str,
        token: &'a str,
        broadcaster_id: &'a str,
        channel_login: &'a str,
        user_id: &'a str,
    }
    let cmd = ConnectCmd {
        cmd: "twitch_connect",
        client_id: &creds.client_id,
        token: &creds.access_token,
        broadcaster_id: &creds.broadcaster_id,
        channel_login: &creds.channel_login,
        user_id: &creds.user_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Serializes a `first_messages` control command line, which starts or
/// stops the sidecar's first-time chatter watcher.
pub fn build_first_messages_line(enabled: bool) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct FirstMessagesCmd {
        cmd: &'static str,
        enabled: bool,
    }
    let mut bytes = serde_json::to_vec(&FirstMessagesCmd {
        cmd: "first_messages",
        enabled,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// YouTube credentials sourced from environment variables for Phase 0 dev.
#[derive(Debug, Clone)]
pub struct YouTubeCreds {
    pub api_key: String,
    pub live_chat_id: String,
}

/// Serializes a `youtube_connect` control command line for the sidecar.
#[allow(dead_code)]
pub fn build_youtube_connect_line(creds: &YouTubeCreds) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct ConnectCmd<'a> {
        cmd: &'a str,
        api_key: &'a str,
        live_chat_id: &'a str,
    }
    let cmd = ConnectCmd {
        cmd: "youtube_connect",
        api_key: &creds.api_key,
        live_chat_id: &creds.live_chat_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Serializes a `kick_connect` control command line for the sidecar.
#[allow(dead_code)]
pub fn build_kick_connect_line(chatroom_id: i64) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct ConnectCmd {
        cmd: &'static str,
        chatroom_id: i64,
    }
    let cmd = ConnectCmd {
        cmd: "kick_connect",
        chatroom_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Arguments for [`build_send_chat_message_line`]. All fields are
/// borrowed so the caller doesn't have to clone its credentials just to
/// build a control line.
pub struct SendChatMessageArgs<'a> {
    pub client_id: &'a str,
    pub access_token: &'a str,
    pub broadcaster_id: &'a str,
    pub user_id: &'a str,
    pub message: &'a str,
    /// Message this one answers, if any.
    pub reply_parent_message_id: Option<&'a str>,
    /// Opaque correlation id echoed back in the sidecar's
    /// `send_chat_result` notification so the host can match the result
    /// to the awaiting Tauri invocation.
    pub request_id: u64,
}

/// Serializes a `send_chat_message` control command line for the sidecar.
/// The Go side validates message length and emptiness against the same
/// 500-byte Helix cap; this builder is purely a transport encoder.
pub fn build_send_chat_message_line(args: SendChatMessageArgs<'_>) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct SendCmd<'a> {
        cmd: &'a str,
        client_id: &'a str,
        token: &'a str,
        broadcaster_id: &'a str,
        user_id: &'a str,
        message: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_parent_message_id: Option<&'a str>,
        request_id: u64,
    }
    let cmd = SendCmd {
        cmd: "send_chat_message",
        client_id: args.client_id,
        token: args.access_token,
        broadcaster_id: args.broadcaster_id,
        user_id: args.user_id,
        message: args.message,
        reply_parent_message_id: args.reply_parent_message_id,
        request_id: args.request_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub struct TwitchUserModActionArgs<'a> {
    pub cmd: &'a str,
    pub client_id: &'a str,
    pub access_token: &'a str,
    pub broadcaster_id: &'a str,
    pub user_id: &'a str,
    pub target_user_id: &'a str,
    pub reason: &'a str,
    pub request_id: u64,
}

pub fn build_twitch_user_mod_action_line(
    args: TwitchUserModActionArgs<'_>,
) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct ModCmd<'a> {
        cmd: &'a str,
        client_id: &'a str,
        token: &'a str,
        broadcaster_id: &'a str,
        user_id: &'a str,
        target_user_id: &'a str,
        #[serde(skip_serializing_if = "str::is_empty")]
        reason: &'a str,
        request_id: u64,
    }
    let cmd = ModCmd {
        cmd: args.cmd,
        client_id: args.client_id,
        token: args.access_token,
        broadcaster_id: args.broadcaster_id,
        user_id: args.user_id,
        target_user_id: args.target_user_id,
        reason: args.reason,
        request_id: args.request_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub struct TwitchTimeoutArgs<'a> {
    pub client_id: &'a str,
    pub access_token: &'a str,
    pub broadcaster_id: &'a str,
    pub user_id: &'a str,
    pub target_user_id: &'a str,
    pub duration_seconds: u32,
    pub reason: &'a str,
    pub request_id: u64,
}

pub fn build_twitch_timeout_line(args: TwitchTimeoutArgs<'_>) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct TimeoutCmd<'a> {
        cmd: &'a str,
        client_id: &'a str,
        token: &'a str,
        broadcaster_id: &'a str,
        user_id: &'a str,
        target_user_id: &'a str,
        duration_seconds: u32,
        #[serde(skip_serializing_if = "str::is_empty")]
        reason: &'a str,
        request_id: u64,
    }
    let cmd = TimeoutCmd {
        cmd: "timeout_user",
        client_id: args.client_id,
        token: args.access_token,
        broadcaster_id: args.broadcaster_id,
        user_id: args.user_id,
        target_user_id: args.target_user_id,
        duration_seconds: args.duration_seconds,
        reason: args.reason,
        request_id: args.request_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub struct TwitchDeleteMessageArgs<'a> {
    pub client_id: &'a str,
    pub access_token: &'a str,
    pub broadcaster_id: &'a str,
    pub user_id: &'a str,
    pub message_id: &'a str,
    pub request_id: u64,
}

pub fn build_twitch_delete_message_line(
    args: TwitchDeleteMessageArgs<'_>,
) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct DeleteCmd<'a> {
        cmd: &'a str,
        client_id: &'a str,
        token: &'a str,
        broadcaster_id: &'a str,
        user_id: &'a str,
        message_id: &'a str,
        request_id: u64,
    }
    let cmd = DeleteCmd {
        cmd: "delete_message",
        client_id: args.client_id,
        token: args.access_token,
        broadcaster_id: args.broadcaster_id,
        user_id: args.user_id,
        message_id: args.message_id,
        request_id: args.request_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub struct TwitchClearChatArgs<'a> {
    pub client_id: &'a str,
    pub access_token: &'a str,
    pub broadcaster_id: &'a str,
    pub user_id: &'a str,
    pub request_id: u64,
}

pub fn build_twitch_clear_chat_line(args: TwitchClearChatArgs<'_>) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct ClearCmd<'a> {
        cmd: &'a str,
        client_id: &'a str,
        token: &'a str,
        broadcaster_id: &'a str,
        user_id: &'a str,
        request_id: u64,
    }
    let cmd = ClearCmd {
        cmd: "clear_chat",
        client_id: args.client_id,
        token: args.access_token,
        broadcaster_id: args.broadcaster_id,
        user_id: args.user_id,
        request_id: args.request_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Arguments for [`build_youtube_send_message_line`]. Mirrors the
/// Twitch shape but trimmed to what the YouTube Data API needs (no
/// client_id, no broadcaster/sender split — the access token's owner
/// is implicitly the sender, and the destination is keyed by the
/// `live_chat_id`).
pub struct YouTubeSendMessageArgs<'a> {
    pub access_token: &'a str,
    pub live_chat_id: &'a str,
    pub message: &'a str,
    /// Opaque correlation id echoed back in the sidecar's
    /// `send_chat_result` notification. Shared registry with Twitch
    /// sends — request_ids are unique per [`crate::sidecar_commands::Pending`]
    /// so the platform of origin doesn't need to be encoded here.
    pub request_id: u64,
}

/// Serializes a `youtube_send_message` control command line for the
/// sidecar. The sidecar issues a YouTube Data API
/// `POST /liveChat/messages` and replies with the standard
/// `send_chat_result` notification shape.
pub fn build_youtube_send_message_line(
    args: YouTubeSendMessageArgs<'_>,
) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct SendCmd<'a> {
        cmd: &'a str,
        token: &'a str,
        live_chat_id: &'a str,
        message: &'a str,
        request_id: u64,
    }
    let cmd = SendCmd {
        cmd: "youtube_send_message",
        token: args.access_token,
        live_chat_id: args.live_chat_id,
        message: args.message,
        request_id: args.request_id,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Serializes a `token_refresh` control command line for the sidecar.
/// The sidecar updates the access token on all running Twitch clients
/// so the next EventSub reconnect uses a fresh credential.
pub fn build_token_refresh_line(access_token: &str) -> serde_json::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct RefreshCmd<'a> {
        cmd: &'a str,
        token: &'a str,
    }
    let cmd = RefreshCmd {
        cmd: "token_refresh",
        token: access_token,
    };
    let mut bytes = serde_json::to_vec(&cmd)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Marks a shared memory HANDLE inheritable just before spawning a child
/// process. See ADR 18 for why this is necessary.
#[cfg(windows)]
pub fn mark_handle_inheritable(handle: RawHandle) -> std::io::Result<()> {
    use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    unsafe {
        SetHandleInformation(
            HANDLE(handle as *mut _),
            HANDLE_FLAG_INHERIT.0,
            HANDLE_FLAG_INHERIT,
        )
        .map_err(std::io::Error::other)
    }
}

/// Clears the inheritable flag on a HANDLE immediately after the child is
/// spawned, so any subsequent child created by this process does not
/// accidentally inherit the same handle.
#[cfg(windows)]
pub fn unmark_handle_inheritable(handle: RawHandle) -> std::io::Result<()> {
    use windows::Win32::Foundation::{
        SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
    };
    unsafe {
        SetHandleInformation(
            HANDLE(handle as *mut _),
            HANDLE_FLAG_INHERIT.0,
            HANDLE_FLAGS(0),
        )
        .map_err(std::io::Error::other)
    }
}

#[cfg(not(windows))]
pub fn mark_handle_inheritable(_handle: RawHandle) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "handle inheritance not yet supported on this platform",
    ))
}

#[cfg(not(windows))]
pub fn unmark_handle_inheritable(_handle: RawHandle) -> std::io::Result<()> {
    Ok(())
}

/// Parsed variant of a single line the sidecar emits on stdout. Unknown or
/// malformed lines are surfaced as explicit variants so the caller can log
/// them consistently rather than swallowing.
pub enum SidecarEvent {
    /// `{"type":"heartbeat","payload":{...}}`. The supervisor tracks
    /// liveness via child-process exit rather than heartbeat gaps so this
    /// variant is currently just a structured marker for future watchdogs.
    Heartbeat,
    /// `{"type":"emote_bundle","payload":Bundle}`. Built on channel-join,
    /// consumed by the host to rebuild its emote index. Boxed because the
    /// bundle is much larger than the other variants.
    EmoteBundle(Box<EmoteBundle>),
    /// `{"type":"send_chat_result","payload":SendChatResult}`. Routed
    /// back to the awaiting `twitch_send_message` invocation via its
    /// `request_id` correlation field.
    SendChatResult(SendChatResult),
    /// `{"type":"mod_action_result","payload":SendChatResult}`. Uses the
    /// same result envelope as send-chat: `ok` for success, drop/error fields
    /// for API failures, and `request_id` for correlation.
    ModActionResult(SendChatResult),
    /// `{"type":"chat_banned","payload":ChatBanned}`. Twitch refuses to
    /// deliver the channel's chat to the signed-in user (banned or timed
    /// out there) and the sidecar has stopped that channel's client.
    ChatBanned(ChatBanned),
    /// `{"type":"first_message","payload":FirstMessage}`. Twitch IRC
    /// tagged the message as its chatter's first in the channel.
    FirstMessage(FirstMessage),
    /// A well-formed `{type, payload}` message the host does not yet
    /// recognize. The inner string is the type tag.
    Other(String),
    /// Line was not valid JSON or lacked the `{type, payload}` shape.
    Invalid,
}

/// Payload of a `chat_banned` notification, forwarded to the webview as
/// the `chat_banned` event. `detail` is Twitch's wording: the 403 body at
/// subscribe time or the `chat_user_banned` revocation status.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ChatBanned {
    pub broadcaster_id: String,
    #[serde(default)]
    pub detail: String,
}

/// Payload of a `first_message` notification, forwarded to the webview as
/// the `first_message` event. `message_id` is the IRC `id` tag, which is
/// the same id EventSub gives the message.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct FirstMessage {
    pub channel_id: String,
    pub message_id: String,
}

/// Parsed payload of a `send_chat_result` notification. Mirrors the
/// Go-side `sidecar.SendChatResultPayload` shape.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SendChatResult {
    /// Echoed-back correlation id from the originating `send_chat_message`
    /// command. The host uses this to find the awaiting completer.
    #[serde(default)]
    pub request_id: u64,
    pub ok: bool,
    /// Helix-assigned id for a successfully accepted message. Surfaced
    /// to the frontend by `twitch_send_message` so the optimistic
    /// renderer can correlate the locally-inserted pending message with
    /// the authoritative EventSub echo.
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub drop_code: String,
    #[serde(default)]
    pub drop_message: String,
    #[serde(default)]
    pub error_message: String,
    /// HTTP status Helix answered with when the failure was an HTTP
    /// error, zero otherwise. Lets the host tell a dead token (401) from
    /// a rejected request without parsing the message text.
    #[serde(default)]
    pub http_status: u16,
}

/// Parses one line of sidecar stdout into a [`SidecarEvent`]. The sidecar
/// writes one JSON object per line via `json.Encoder.Encode`, so `bytes`
/// should be the full line without the trailing newline. Leading/trailing
/// whitespace is tolerated.
pub fn parse_sidecar_event(bytes: &[u8]) -> SidecarEvent {
    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(rename = "type", default)]
        msg_type: String,
        #[serde(default)]
        payload: Option<serde_json::Value>,
    }

    let trimmed = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map(|i| &bytes[i..])
        .unwrap_or(&[]);
    if trimmed.is_empty() {
        return SidecarEvent::Invalid;
    }
    let Ok(env) = serde_json::from_slice::<Envelope>(trimmed) else {
        return SidecarEvent::Invalid;
    };
    match env.msg_type.as_str() {
        "heartbeat" => SidecarEvent::Heartbeat,
        "emote_bundle" => {
            let payload = env.payload.unwrap_or(serde_json::Value::Null);
            match serde_json::from_value::<EmoteBundle>(payload) {
                Ok(b) => SidecarEvent::EmoteBundle(Box::new(b)),
                Err(e) => {
                    tracing::warn!(error = %e, "emote_bundle payload decode failed");
                    SidecarEvent::Invalid
                }
            }
        }
        "send_chat_result" => {
            let payload = env.payload.unwrap_or(serde_json::Value::Null);
            match serde_json::from_value::<SendChatResult>(payload) {
                Ok(r) => SidecarEvent::SendChatResult(r),
                Err(e) => {
                    tracing::warn!(error = %e, "send_chat_result payload decode failed");
                    SidecarEvent::Invalid
                }
            }
        }
        "mod_action_result" => {
            let payload = env.payload.unwrap_or(serde_json::Value::Null);
            match serde_json::from_value::<SendChatResult>(payload) {
                Ok(r) => SidecarEvent::ModActionResult(r),
                Err(e) => {
                    tracing::warn!(error = %e, "mod_action_result payload decode failed");
                    SidecarEvent::Invalid
                }
            }
        }
        "chat_banned" => {
            let payload = env.payload.unwrap_or(serde_json::Value::Null);
            match serde_json::from_value::<ChatBanned>(payload) {
                Ok(b) => SidecarEvent::ChatBanned(b),
                Err(e) => {
                    tracing::warn!(error = %e, "chat_banned payload decode failed");
                    SidecarEvent::Invalid
                }
            }
        }
        "first_message" => {
            let payload = env.payload.unwrap_or(serde_json::Value::Null);
            match serde_json::from_value::<FirstMessage>(payload) {
                Ok(f) => SidecarEvent::FirstMessage(f),
                Err(e) => {
                    tracing::warn!(error = %e, "first_message payload decode failed");
                    SidecarEvent::Invalid
                }
            }
        }
        "" => SidecarEvent::Invalid,
        other => SidecarEvent::Other(other.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::Platform;

    #[test]
    fn bootstrap_line_has_expected_fields_and_newline() {
        let line = build_bootstrap_line(0xDEADBEEF, 0xCAFEBABE, 4096).unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let body = &line[..line.len() - 1];
        let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(parsed["shm_handle"], 0xDEADBEEF_u64);
        assert_eq!(parsed["shm_event_handle"], 0xCAFEBABE_u64);
        assert_eq!(parsed["shm_size"], 4096_u64);
    }

    #[test]
    fn twitch_connect_line_has_all_required_fields() {
        let creds = TwitchCreds {
            client_id: "cid".into(),
            access_token: "tok".into(),
            broadcaster_id: "bid".into(),
            channel_login: "streamer".into(),
            user_id: "uid".into(),
        };
        let line = build_twitch_connect_line(&creds).unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let body = &line[..line.len() - 1];
        let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(parsed["cmd"], "twitch_connect");
        assert_eq!(parsed["client_id"], "cid");
        assert_eq!(parsed["token"], "tok");
        assert!(parsed.get("reply_parent_message_id").is_none());
        assert_eq!(parsed["broadcaster_id"], "bid");
        assert_eq!(parsed["channel_login"], "streamer");
        assert_eq!(parsed["user_id"], "uid");
    }

    #[test]
    fn parse_batch_routes_irc_lines() {
        let mut line = vec![TAG_TWITCH_IRC];
        line.extend_from_slice(
            b"@id=m1;room-id=9;tmi-sent-ts=5;user-id=7 :alice!alice@alice.tmi.twitch.tv PRIVMSG #c :hi",
        );
        let mut clear = vec![TAG_TWITCH_IRC];
        clear.extend_from_slice(b"@room-id=9;tmi-sent-ts=6 :tmi.twitch.tv CLEARCHAT #c");
        let mut batch = Vec::new();
        let mut events = Vec::new();
        parse_batch(
            &[line, clear],
            &mut batch,
            &mut events,
            &EmoteIndexes::new(),
        );
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].id, "m1");
        assert_eq!(batch[0].channel_id, "9");
        assert_eq!(
            events,
            vec![ChatEvent::ChatCleared {
                channel_id: "9".into()
            }]
        );
    }

    /// A bundle for the fixtures' broadcaster (`broadcaster_user_id` is
    /// absent in them, so it is the empty id) holding one emote.
    fn kappa_bundle(emote: crate::emote_index::EmoteMeta) -> EmoteBundle {
        EmoteBundle {
            twitch_global_emotes: crate::emote_index::EmoteSet {
                emotes: vec![emote],
            },
            ..EmoteBundle::default()
        }
    }

    fn tag_twitch(json: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(1 + json.len());
        v.push(TAG_TWITCH);
        v.extend_from_slice(json);
        v
    }

    fn tag_youtube(json: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(1 + json.len());
        v.push(TAG_YOUTUBE);
        v.extend_from_slice(json);
        v
    }

    #[test]
    fn parse_batch_filters_non_chat_and_parse_errors() {
        let viewer = tag_twitch(br##"{
            "metadata": {"message_id":"m","message_type":"notification","message_timestamp":"2023-11-06T18:11:47.492Z"},
            "payload": {
                "subscription": {"type":"channel.chat.message"},
                "event": {
                    "chatter_user_id":"1","chatter_user_login":"u","chatter_user_name":"U",
                    "message_id":"mid","message":{"text":"hi"}
                }
            }
        }"##);
        let keepalive = tag_twitch(br##"{"metadata":{"message_id":"ka","message_type":"session_keepalive","message_timestamp":"2023-11-06T18:11:49.000Z"},"payload":{}}"##);
        let junk = tag_twitch(b"not json");

        let raw = vec![viewer, keepalive, junk];
        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(&raw, &mut batch, &mut Vec::new(), &idx);
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].message_text, "hi");
        assert!(batch[0].emote_spans.is_empty());
    }

    #[test]
    fn parse_batch_empty_input() {
        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(&[], &mut batch, &mut Vec::new(), &idx);
        assert!(batch.is_empty());
    }

    #[test]
    fn parse_batch_appends_to_existing_scratch() {
        let viewer = tag_twitch(br##"{
            "metadata": {"message_id":"m","message_type":"notification","message_timestamp":"2023-11-06T18:11:47.492Z"},
            "payload": {
                "subscription": {"type":"channel.chat.message"},
                "event": {
                    "chatter_user_id":"1","chatter_user_login":"u","chatter_user_name":"U",
                    "message_id":"mid","message":{"text":"second"}
                }
            }
        }"##);

        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(
            std::slice::from_ref(&viewer),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].message_text, "second");

        // Second call appends, scratch is NOT cleared.
        parse_batch(
            std::slice::from_ref(&viewer),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[1].message_text, "second");
    }

    #[test]
    fn parse_batch_attaches_emote_spans_from_index() {
        use crate::emote_index::{EmoteMeta, Provider};

        let viewer = tag_twitch(br##"{
            "metadata": {"message_id":"m","message_type":"notification","message_timestamp":"2023-11-06T18:11:47.492Z"},
            "payload": {
                "subscription": {"type":"channel.chat.message"},
                "event": {
                    "chatter_user_id":"1","chatter_user_login":"u","chatter_user_name":"U",
                    "message_id":"mid","message":{"text":"hello Kappa world"}
                }
            }
        }"##);

        let idx = EmoteIndexes::new();
        idx.load_bundle(kappa_bundle(EmoteMeta {
            id: "1".into(),
            code: "Kappa".into(),
            provider: Provider::Twitch,
            url_1x: "https://t/1".into(),
            url_2x: "".into(),
            url_4x: "".into(),
            width: 28,
            height: 28,
            animated: false,
            zero_width: false,
        }));

        let mut batch = Vec::new();
        parse_batch(
            std::slice::from_ref(&viewer),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].emote_spans.len(), 1);
        let span = &batch[0].emote_spans[0];
        assert_eq!(span.start, 6);
        assert_eq!(span.end, 11);
        assert_eq!(span.emote.code.as_ref(), "Kappa");
    }

    /// Verify the JSON that Tauri sends to the frontend includes emote_spans
    /// with the expected shape, so the TypeScript `ChatMessage` type matches.
    #[test]
    fn emote_spans_survive_json_serialization() {
        use crate::emote_index::{EmoteMeta, Provider};

        let viewer = tag_twitch(br##"{
            "metadata": {"message_id":"m","message_type":"notification","message_timestamp":"2023-11-06T18:11:47.492Z"},
            "payload": {
                "subscription": {"type":"channel.chat.message"},
                "event": {
                    "chatter_user_id":"1","chatter_user_login":"u","chatter_user_name":"U",
                    "message_id":"mid","message":{"text":"hello Kappa world"}
                }
            }
        }"##);

        let idx = EmoteIndexes::new();
        idx.load_bundle(kappa_bundle(EmoteMeta {
            id: "25".into(),
            code: "Kappa".into(),
            provider: Provider::Twitch,
            url_1x: "https://cdn/Kappa/1x".into(),
            url_2x: "https://cdn/Kappa/2x".into(),
            url_4x: "https://cdn/Kappa/4x".into(),
            width: 28,
            height: 28,
            animated: false,
            zero_width: false,
        }));

        let mut batch = Vec::new();
        parse_batch(
            std::slice::from_ref(&viewer),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 1);

        let json = serde_json::to_value(&batch[0]).unwrap();
        let spans = json["emote_spans"].as_array().unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0]["start"], 6);
        assert_eq!(spans[0]["end"], 11);
        assert_eq!(spans[0]["emote"]["code"], "Kappa");
        assert_eq!(spans[0]["emote"]["url_1x"], "https://cdn/Kappa/1x");
        assert_eq!(spans[0]["emote"]["provider"], "twitch");
        assert_eq!(spans[0]["emote"]["width"], 28);
        assert_eq!(spans[0]["emote"]["height"], 28);
    }

    #[test]
    fn parse_batch_routes_youtube_messages() {
        let yt_msg = tag_youtube(br##"{"id":"yt-1","snippet":{"type":"TEXT_MESSAGE_EVENT","published_at":"2024-01-01T00:00:00Z","display_message":"hello from yt","text_message_details":{"message_text":"hello from yt"}},"author_details":{"channel_id":"UC123","display_name":"YTUser","is_chat_owner":false,"is_chat_moderator":false,"is_chat_sponsor":false}}"##);

        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(
            std::slice::from_ref(&yt_msg),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].message_text, "hello from yt");
        assert!(matches!(batch[0].platform, Platform::YouTube));
        assert_eq!(batch[0].display_name, "YTUser");
    }

    #[test]
    fn parse_batch_mixed_platforms() {
        let twitch = tag_twitch(br##"{"metadata":{"message_id":"m","message_type":"notification","message_timestamp":"2023-11-06T18:11:47.492Z"},"payload":{"subscription":{"type":"channel.chat.message"},"event":{"chatter_user_id":"1","chatter_user_login":"u","chatter_user_name":"U","message_id":"mid","message":{"text":"from twitch"}}}}"##);
        let yt = tag_youtube(br##"{"id":"yt-1","snippet":{"type":"TEXT_MESSAGE_EVENT","published_at":"2024-01-01T00:00:00Z","text_message_details":{"message_text":"from youtube"}},"author_details":{"channel_id":"UC1","display_name":"YT"}}"##);

        let raw = vec![twitch, yt];
        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(&raw, &mut batch, &mut Vec::new(), &idx);
        assert_eq!(batch.len(), 2);
        assert!(matches!(batch[0].platform, Platform::Twitch));
        assert!(matches!(batch[1].platform, Platform::YouTube));
    }

    #[test]
    fn parse_batch_handles_kick_messages() {
        let kick_msg = {
            let json = br##"{"event":"App\\Events\\ChatMessageEvent","data":"{\"id\":\"k1\",\"chatroom_id\":100,\"content\":\"hello from kick\",\"type\":\"message\",\"created_at\":\"2025-06-01T12:00:00Z\",\"sender\":{\"id\":42,\"username\":\"kuser\",\"slug\":\"kuser\",\"identity\":{\"color\":\"#00FF00\",\"badges\":[]}}}","channel":"chatrooms.100.v2"}"##;
            let mut tagged = vec![TAG_KICK];
            tagged.extend_from_slice(json);
            tagged
        };

        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(
            std::slice::from_ref(&kick_msg),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].message_text, "hello from kick");
        assert!(matches!(batch[0].platform, crate::message::Platform::Kick));
    }

    #[test]
    fn parse_batch_skips_empty_payloads() {
        let raw = vec![vec![]];
        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(&raw, &mut batch, &mut Vec::new(), &idx);
        assert!(batch.is_empty());
    }

    #[test]
    fn parse_batch_unknown_tag_dropped() {
        let mut payload = vec![0xFF];
        payload.extend_from_slice(b"{}");
        let raw = vec![payload];
        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(&raw, &mut batch, &mut Vec::new(), &idx);
        assert!(batch.is_empty());
    }

    /// parse_batch is responsible for stamping `effective_ts`. The platform
    /// timestamp here is from 2023, so it's far outside the snap window
    /// from `arrival_time` (now), which means the rule must fall back to
    /// `arrival_time`.
    #[test]
    fn parse_batch_stamps_effective_ts_using_snap_rule() {
        let viewer = tag_twitch(br##"{
            "metadata": {"message_id":"m","message_type":"notification","message_timestamp":"2023-11-06T18:11:47.492Z"},
            "payload": {
                "subscription": {"type":"channel.chat.message"},
                "event": {
                    "chatter_user_id":"1","chatter_user_login":"u","chatter_user_name":"U",
                    "message_id":"mid","message":{"text":"hi"}
                }
            }
        }"##);

        let mut batch = Vec::new();
        let idx = EmoteIndexes::new();
        parse_batch(
            std::slice::from_ref(&viewer),
            &mut batch,
            &mut Vec::new(),
            &idx,
        );
        assert_eq!(batch.len(), 1);
        // Far-stale platform ts → effective_ts falls back to arrival_time.
        assert_eq!(batch[0].effective_ts, batch[0].arrival_time);
        // arrival_seq is left at 0; the supervisor stamps it before emit.
        assert_eq!(batch[0].arrival_seq, 0);
    }

    #[cfg(windows)]
    #[test]
    fn mark_and_unmark_handle_inheritance_round_trip() {
        use crate::ringbuf;

        let reader = ringbuf::RingBufReader::create_owner(4096).unwrap();
        let handle = reader.raw_handle();

        mark_handle_inheritable(handle).expect("mark should succeed");
        unmark_handle_inheritable(handle).expect("unmark should succeed");
    }

    #[test]
    fn parse_sidecar_event_recognizes_heartbeat() {
        let line = br#"{"type":"heartbeat","payload":{"ts_ms":123,"counter":4}}"#;
        assert!(matches!(parse_sidecar_event(line), SidecarEvent::Heartbeat));
    }

    #[test]
    fn parse_sidecar_event_decodes_emote_bundle() {
        let line = br#"{"type":"emote_bundle","payload":{
            "twitch_global_emotes":{"provider":"twitch","scope":"global","emotes":[
                {"id":"1","code":"Kappa","provider":"twitch","url_1x":"https://t/1"}
            ]},
            "twitch_channel_emotes":{"provider":"twitch","scope":"channel","emotes":[]},
            "twitch_global_badges":{"scope":"global","badges":[]},
            "twitch_channel_badges":{"scope":"channel","badges":[]},
            "seventv_global":{"provider":"7tv","scope":"global","emotes":[]},
            "seventv_channel":{"provider":"7tv","scope":"channel","emotes":[]},
            "bttv_global":{"provider":"bttv","scope":"global","emotes":[]},
            "bttv_channel":{"provider":"bttv","scope":"channel","emotes":[]},
            "ffz_global":{"provider":"ffz","scope":"global","emotes":[]},
            "ffz_channel":{"provider":"ffz","scope":"channel","emotes":[]}
        }}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::EmoteBundle(b) => {
                assert_eq!(b.total_emotes(), 1);
                assert_eq!(b.twitch_global_emotes.emotes[0].code.as_ref(), "Kappa");
            }
            _ => panic!("expected EmoteBundle variant"),
        }
    }

    #[test]
    fn parse_sidecar_event_decodes_chat_banned() {
        let line = br#"{"type":"chat_banned","payload":{"broadcaster_id":"42","detail":"chat_user_banned"}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::ChatBanned(b) => {
                assert_eq!(b.broadcaster_id, "42");
                assert_eq!(b.detail, "chat_user_banned");
            }
            _ => panic!("expected ChatBanned variant"),
        }
        assert!(matches!(
            parse_sidecar_event(br#"{"type":"chat_banned","payload":{}}"#),
            SidecarEvent::Invalid
        ));
    }

    #[test]
    fn parse_sidecar_event_decodes_first_message() {
        let line = br#"{"type":"first_message","payload":{"channel_id":"42","message_id":"abc"}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::FirstMessage(f) => {
                assert_eq!(f.channel_id, "42");
                assert_eq!(f.message_id, "abc");
            }
            _ => panic!("expected FirstMessage variant"),
        }
        assert!(matches!(
            parse_sidecar_event(br#"{"type":"first_message","payload":{"channel_id":"42"}}"#),
            SidecarEvent::Invalid
        ));
    }

    #[test]
    fn first_messages_line_carries_the_switch() {
        for enabled in [true, false] {
            let line = build_first_messages_line(enabled).unwrap();
            assert_eq!(line.last(), Some(&b'\n'));
            let parsed: serde_json::Value =
                serde_json::from_slice(&line[..line.len() - 1]).unwrap();
            assert_eq!(parsed["cmd"], "first_messages");
            assert_eq!(parsed["enabled"], enabled);
        }
    }

    #[test]
    fn parse_sidecar_event_handles_unknown_type() {
        let line = br#"{"type":"future_thing","payload":{"x":1}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::Other(t) => assert_eq!(t, "future_thing"),
            _ => panic!("expected Other variant"),
        }
    }

    #[test]
    fn parse_sidecar_event_rejects_non_json() {
        assert!(matches!(
            parse_sidecar_event(b"plain text log line"),
            SidecarEvent::Invalid
        ));
        assert!(matches!(
            parse_sidecar_event(b"   \t  "),
            SidecarEvent::Invalid
        ));
        assert!(matches!(parse_sidecar_event(b""), SidecarEvent::Invalid));
    }

    #[test]
    fn parse_sidecar_event_rejects_malformed_emote_bundle_payload() {
        // Type tag is right but payload shape is wrong. Return Invalid so the
        // caller logs it, rather than silently dropping it as Other.
        let line = br#"{"type":"emote_bundle","payload":{"twitch_global_emotes":"oops"}}"#;
        assert!(matches!(parse_sidecar_event(line), SidecarEvent::Invalid));
    }

    #[test]
    fn parse_sidecar_event_decodes_send_chat_result_success() {
        let line = br#"{"type":"send_chat_result","payload":{"request_id":42,"ok":true,"message_id":"abc"}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::SendChatResult(r) => {
                assert_eq!(r.request_id, 42);
                assert!(r.ok);
                assert_eq!(r.message_id, "abc");
            }
            _ => panic!("expected SendChatResult"),
        }
    }

    #[test]
    fn parse_sidecar_event_decodes_send_chat_result_drop() {
        let line = br#"{"type":"send_chat_result","payload":{"request_id":7,"ok":false,"drop_code":"msg_duplicate","drop_message":"dup"}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::SendChatResult(r) => {
                assert_eq!(r.request_id, 7);
                assert!(!r.ok);
                assert_eq!(r.drop_code, "msg_duplicate");
            }
            _ => panic!("expected SendChatResult"),
        }
    }

    #[test]
    fn parse_sidecar_event_decodes_mod_action_result() {
        let line = br#"{"type":"mod_action_result","payload":{"request_id":9,"ok":false,"drop_code":"unauthorized","drop_message":"missing scope","http_status":401}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::ModActionResult(r) => {
                assert_eq!(r.request_id, 9);
                assert!(!r.ok);
                assert_eq!(r.drop_code, "unauthorized");
                assert_eq!(r.http_status, 401);
            }
            _ => panic!("expected ModActionResult"),
        }
    }

    #[test]
    fn send_chat_result_http_status_defaults_to_zero() {
        let line =
            br#"{"type":"send_chat_result","payload":{"request_id":1,"ok":true,"message_id":"m"}}"#;
        match parse_sidecar_event(line) {
            SidecarEvent::SendChatResult(r) => assert_eq!(r.http_status, 0),
            _ => panic!("expected SendChatResult"),
        }
    }

    #[test]
    fn build_send_chat_message_line_includes_request_id() {
        let line = build_send_chat_message_line(SendChatMessageArgs {
            client_id: "cid",
            access_token: "tok",
            broadcaster_id: "b",
            user_id: "u",
            message: "hi",
            reply_parent_message_id: None,
            request_id: 99,
        })
        .unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let body = &line[..line.len() - 1];
        let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(parsed["cmd"], "send_chat_message");
        assert_eq!(parsed["request_id"], 99);
        assert_eq!(parsed["broadcaster_id"], "b");
        assert_eq!(parsed["message"], "hi");
        assert_eq!(parsed["token"], "tok");
    }

    #[test]
    fn build_twitch_user_mod_action_line_serializes_required_fields() {
        let line = build_twitch_user_mod_action_line(TwitchUserModActionArgs {
            cmd: "ban_user",
            client_id: "cid",
            access_token: "tok",
            broadcaster_id: "b",
            user_id: "u",
            target_user_id: "target",
            reason: "spam",
            request_id: 3,
        })
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed["cmd"], "ban_user");
        assert_eq!(parsed["target_user_id"], "target");
        assert_eq!(parsed["reason"], "spam");
        assert_eq!(parsed["request_id"], 3_u64);
    }

    #[test]
    fn build_twitch_timeout_line_serializes_duration() {
        let line = build_twitch_timeout_line(TwitchTimeoutArgs {
            client_id: "cid",
            access_token: "tok",
            broadcaster_id: "b",
            user_id: "u",
            target_user_id: "target",
            duration_seconds: 60,
            reason: "caps",
            request_id: 4,
        })
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed["cmd"], "timeout_user");
        assert_eq!(parsed["duration_seconds"], 60_u64);
    }

    #[test]
    fn build_twitch_delete_message_line_serializes_message_id() {
        let line = build_twitch_delete_message_line(TwitchDeleteMessageArgs {
            client_id: "cid",
            access_token: "tok",
            broadcaster_id: "b",
            user_id: "u",
            message_id: "m1",
            request_id: 5,
        })
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed["cmd"], "delete_message");
        assert_eq!(parsed["message_id"], "m1");
    }

    #[test]
    fn build_twitch_clear_chat_line_has_no_message_id() {
        let line = build_twitch_clear_chat_line(TwitchClearChatArgs {
            client_id: "cid",
            access_token: "tok",
            broadcaster_id: "b",
            user_id: "u",
            request_id: 6,
        })
        .unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let parsed: serde_json::Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed["cmd"], "clear_chat");
        assert_eq!(parsed["broadcaster_id"], "b");
        assert_eq!(parsed["request_id"], 6_u64);
        assert!(parsed.get("message_id").is_none());
    }

    #[test]
    fn build_token_refresh_line_has_cmd_and_token() {
        let line = build_token_refresh_line("fresh-tok").unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let body = &line[..line.len() - 1];
        let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(parsed["cmd"], "token_refresh");
        assert_eq!(parsed["token"], "fresh-tok");
    }

    #[test]
    fn build_youtube_send_message_line_serializes_required_fields() {
        let line = build_youtube_send_message_line(YouTubeSendMessageArgs {
            access_token: "yt-tok",
            live_chat_id: "Cg0KC0xpdmVfQ2hhdF9JZA==",
            message: "hello yt",
            request_id: 17,
        })
        .unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let body = &line[..line.len() - 1];
        let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(parsed["cmd"], "youtube_send_message");
        assert_eq!(parsed["token"], "yt-tok");
        assert_eq!(parsed["live_chat_id"], "Cg0KC0xpdmVfQ2hhdF9JZA==");
        assert_eq!(parsed["message"], "hello yt");
        assert_eq!(parsed["request_id"], 17);
    }
}
