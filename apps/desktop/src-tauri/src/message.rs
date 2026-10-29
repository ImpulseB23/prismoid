//! Unified message type emitted to the frontend, plus parsers that convert
//! raw platform envelopes into it.

use serde::{Deserialize, Serialize};

use crate::emote_index::EmoteSpan;
use crate::twitch_ads::{ad_break_from_event, AdBreak};
use crate::twitch_polls::{poll_from_event, prediction_from_event, Poll, Prediction};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Platform {
    Twitch,
    YouTube,
    Kick,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Badge {
    pub set_id: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyParent {
    pub user_login: String,
    pub user_name: String,
    pub body: String,
    /// The message that started the thread. Empty when the platform did not
    /// say, in which case the parent itself is the best guess.
    #[serde(default)]
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedMessage {
    pub id: String,
    pub platform: Platform,
    pub timestamp: i64,
    pub arrival_time: i64,
    /// Effective sort timestamp for unified ordering across platforms.
    /// Set by [`compute_effective_ts`] using the snap rule: trust the
    /// platform-stamped `timestamp` when it agrees with `arrival_time`
    /// within [`SNAP_WINDOW_MS`], else fall back to `arrival_time`. This
    /// keeps cross-platform interleave coherent without ever reordering
    /// already-rendered messages because of vendor clock disagreement.
    pub effective_ts: i64,
    /// Monotonic per-process arrival counter assigned by [`assign_arrival_seqs`].
    /// The frontend uses `(effective_ts, arrival_seq)` as a stable sort
    /// key so two messages with identical effective timestamps never swap
    /// position on re-render.
    pub arrival_seq: u64,
    pub username: String,
    pub display_name: String,
    pub platform_user_id: String,
    /// Identifier of the room the message was posted in: Twitch
    /// broadcaster id, YouTube live chat id, or Kick chatroom id. Lets the
    /// frontend drop stragglers from a previous channel after a switch.
    pub channel_id: String,
    pub message_text: String,
    pub badges: Vec<Badge>,
    pub is_mod: bool,
    pub is_subscriber: bool,
    pub is_broadcaster: bool,
    pub color: Option<String>,
    pub reply_to: Option<String>,
    /// Who and what a Twitch reply answers, for rendering the quoted line.
    pub reply_parent: Option<ReplyParent>,
    /// Set on Twitch system notices (subs, raids, announcements).
    pub notice: Option<ChatNotice>,
    /// Emote matches inside [`message_text`](Self::message_text), populated
    /// by [`crate::emote_index::EmoteIndex::scan_into`] after parsing.
    /// Empty when no index is active or the message has no emotes.
    pub emote_spans: Vec<EmoteSpan>,
}

/// Tolerance window for snapping `effective_ts` to the platform-stamped
/// `timestamp`. Inside this window we trust the platform's clock; outside
/// it we fall back to local arrival time so cross-platform interleave
/// stays coherent. 500 ms is enough to absorb normal vendor clock skew
/// without letting badly delayed messages time-travel up the visible list.
pub const SNAP_WINDOW_MS: i64 = 500;

/// Computes the effective sort timestamp using the snap rule documented
/// on [`UnifiedMessage::effective_ts`]. Pure so the rule can be tested
/// directly without going through a parser.
#[inline]
pub fn compute_effective_ts(timestamp: i64, arrival_time: i64) -> i64 {
    if (timestamp - arrival_time).abs() <= SNAP_WINDOW_MS {
        timestamp
    } else {
        arrival_time
    }
}

/// Stamps every message in `batch` with a monotonic `arrival_seq`,
/// advancing the caller-owned `next_seq` once per message. The drain loop
/// owns the counter so seq is unique for the lifetime of one sidecar run,
/// and the frontend's `(effective_ts, arrival_seq)` sort key remains
/// stable.
pub fn assign_arrival_seqs(batch: &mut [UnifiedMessage], next_seq: &mut u64) {
    for msg in batch.iter_mut() {
        msg.arrival_seq = *next_seq;
        *next_seq = next_seq.wrapping_add(1);
    }
}

#[derive(Debug)]
pub enum ParseError {
    Json(serde_json::Error),
    Timestamp(chrono::ParseError),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(e) => write!(f, "json parse failed: {e}"),
            Self::Timestamp(e) => write!(f, "timestamp parse failed: {e}"),
        }
    }
}

impl std::error::Error for ParseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(e) => Some(e),
            Self::Timestamp(e) => Some(e),
        }
    }
}

impl From<serde_json::Error> for ParseError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

// --- Twitch EventSub deserialization types (private, narrow) ---

#[derive(Debug, Deserialize)]
struct TwitchEnvelope {
    metadata: TwitchMetadata,
    #[serde(default)]
    payload: Option<TwitchPayload>,
}

#[derive(Debug, Deserialize)]
struct TwitchMetadata {
    message_type: String,
    message_timestamp: String,
}

#[derive(Debug, Deserialize)]
struct TwitchPayload {
    #[serde(default)]
    subscription: Option<TwitchSubscription>,
    // Event is held as an opaque Value and only deserialized to the concrete
    // chat event type once we have confirmed the subscription type matches.
    // This lets non-chat notifications (channel.follow, etc.) parse cleanly
    // instead of failing on the missing chat-specific fields.
    #[serde(default)]
    event: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TwitchSubscription {
    #[serde(rename = "type")]
    subscription_type: String,
}

/// Twitch sends `null` for fields it documents as plain strings (shared
/// chat sources, anonymous chatters, empty notice bodies). `#[serde(default)]`
/// only covers a missing key, so explicit nulls go through here and land
/// on the type's default instead of failing the whole envelope.
pub(crate) fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct TwitchChatEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    chatter_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    chatter_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    chatter_user_name: String,
    message_id: String,
    #[serde(default, deserialize_with = "null_default")]
    message: TwitchChatMessage,
    #[serde(default)]
    color: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    badges: Vec<TwitchBadge>,
    #[serde(default)]
    reply: Option<TwitchReply>,
}

#[derive(Debug, Default, Deserialize)]
struct TwitchChatMessage {
    #[serde(default, deserialize_with = "null_default")]
    text: String,
}

#[derive(Debug, Deserialize)]
struct TwitchBadge {
    #[serde(default, deserialize_with = "null_default")]
    set_id: String,
    #[serde(default, deserialize_with = "null_default")]
    id: String,
}

#[derive(Debug, Deserialize)]
struct TwitchReply {
    #[serde(default, deserialize_with = "null_default")]
    parent_message_id: String,
    #[serde(default, deserialize_with = "null_default")]
    parent_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    parent_user_name: String,
    #[serde(default, deserialize_with = "null_default")]
    parent_message_body: String,
    #[serde(default, deserialize_with = "null_default")]
    thread_message_id: String,
}

/// A Twitch system notice rendered inline with chat: subs, resubs, gifts,
/// raids and announcements. Carried on a [`UnifiedMessage`] so it sorts and
/// scrolls like any other row; `system_message` is the line Twitch shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatNotice {
    pub notice_type: String,
    pub system_message: String,
}

/// Moderation events that change messages already shown. Emitted to the
/// frontend as `chat_events`, separate from the message batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEvent {
    MessageDeleted {
        channel_id: String,
        message_id: String,
        target_user_id: String,
    },
    /// A ban or timeout: every message from the target is gone.
    UserCleared {
        channel_id: String,
        target_user_id: String,
        target_user_login: String,
        target_user_name: String,
    },
    ChatCleared {
        channel_id: String,
    },
    /// A moderator did something, from `channel.moderate` v2. Only arrives
    /// in channels where the signed-in user moderates.
    ModAction(Box<ModAction>),
    /// AutoMod is holding a message for review, from
    /// `automod.message.hold` v2. Moderators only.
    AutomodHeld(Box<HeldMessage>),
    /// A held message was approved, denied or expired, from
    /// `automod.message.update` v2.
    AutomodResolved {
        channel_id: String,
        message_id: String,
        /// `approved`, `denied` or `expired`.
        status: String,
        moderator_login: String,
        moderator_name: String,
    },
    /// A poll on the user's own channel began, got votes or ended, from
    /// `channel.poll.*` v1.
    PollUpdate(Box<Poll>),
    /// A prediction on the user's own channel began, got predictions, was
    /// locked or ended, from `channel.prediction.*` v1.
    PredictionUpdate(Box<Prediction>),
    /// An ad break began on the user's own channel, from
    /// `channel.ad_break.begin` v1.
    AdBreak(Box<AdBreak>),
}

/// A message AutoMod is holding. `reason` is `automod`, `blocked_term` or
/// `blocked_link`; `category` and `level` (1 to 4) only come with
/// `automod`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeldMessage {
    pub channel_id: String,
    pub message_id: String,
    pub user_id: String,
    pub user_login: String,
    pub user_name: String,
    pub text: String,
    pub reason: String,
    pub category: String,
    pub level: Option<u8>,
    pub held_at: i64,
}

#[derive(Debug, Deserialize)]
struct TwitchAutomodHoldEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    user_name: String,
    message_id: String,
    #[serde(default, deserialize_with = "null_default")]
    message: TwitchChatMessage,
    #[serde(default, deserialize_with = "null_default")]
    reason: String,
    #[serde(default)]
    automod: Option<TwitchAutomodVerdict>,
    #[serde(default, deserialize_with = "null_default")]
    held_at: String,
}

#[derive(Debug, Deserialize)]
struct TwitchAutomodVerdict {
    #[serde(default, deserialize_with = "null_default")]
    category: String,
    #[serde(default)]
    level: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct TwitchAutomodUpdateEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    message_id: String,
    #[serde(default, deserialize_with = "null_default")]
    status: String,
    #[serde(default, deserialize_with = "null_default")]
    moderator_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    moderator_user_name: String,
}

fn held_message(
    event: TwitchAutomodHoldEvent,
    message_timestamp: &str,
) -> Result<HeldMessage, ParseError> {
    let held_at = match parse_platform_ts(&event.held_at) {
        Ok(ts) => ts,
        Err(_) => parse_platform_ts(message_timestamp)?,
    };
    let (category, level) = event
        .automod
        .map(|a| (a.category, a.level))
        .unwrap_or_default();
    Ok(HeldMessage {
        channel_id: event.broadcaster_user_id,
        message_id: event.message_id,
        user_id: event.user_id,
        user_login: event.user_login,
        user_name: event.user_name,
        text: event.message.text,
        reason: event.reason,
        category,
        level,
        held_at,
    })
}

/// One `channel.moderate` event flattened for the frontend. `action` is
/// Twitch's verb (`timeout`, `ban`, `delete`, `slow`, `vip`, ...); the
/// target fields are filled for actions aimed at a person and the rest
/// carry the one detail each remaining action has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ModAction {
    pub channel_id: String,
    pub timestamp: i64,
    pub moderator_login: String,
    pub moderator_name: String,
    pub action: String,
    pub target_user_id: String,
    pub target_user_login: String,
    pub target_user_name: String,
    pub reason: String,
    /// Timeout length in whole seconds, derived from `expires_at`.
    pub duration_seconds: Option<u64>,
    pub message_id: String,
    pub message_body: String,
    pub wait_time_seconds: Option<u64>,
    pub follow_duration_minutes: Option<u64>,
    pub viewer_count: Option<u64>,
    /// Blocked or permitted terms touched by an `automod_terms` action.
    pub terms: Vec<String>,
    /// Moderator note on an approved or denied unban request.
    pub moderator_message: String,
}

#[derive(Debug, Deserialize)]
struct TwitchModerateEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    moderator_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    moderator_user_name: String,
    #[serde(default, deserialize_with = "null_default")]
    action: String,
    #[serde(default)]
    ban: Option<ModTarget>,
    #[serde(default)]
    unban: Option<ModTarget>,
    #[serde(default)]
    timeout: Option<ModTimeout>,
    #[serde(default)]
    untimeout: Option<ModTarget>,
    #[serde(default)]
    delete: Option<ModDelete>,
    #[serde(default)]
    warn: Option<ModTarget>,
    #[serde(default, rename = "mod")]
    mod_: Option<ModTarget>,
    #[serde(default)]
    unmod: Option<ModTarget>,
    #[serde(default)]
    vip: Option<ModTarget>,
    #[serde(default)]
    unvip: Option<ModTarget>,
    #[serde(default)]
    raid: Option<ModRaid>,
    #[serde(default)]
    unraid: Option<ModTarget>,
    #[serde(default)]
    slow: Option<ModSlow>,
    #[serde(default)]
    followers: Option<ModFollowers>,
    #[serde(default)]
    automod_terms: Option<ModTerms>,
    #[serde(default)]
    unban_request: Option<ModUnbanRequest>,
    #[serde(default)]
    shared_chat_ban: Option<ModTarget>,
    #[serde(default)]
    shared_chat_unban: Option<ModTarget>,
    #[serde(default)]
    shared_chat_timeout: Option<ModTimeout>,
    #[serde(default)]
    shared_chat_untimeout: Option<ModTarget>,
    #[serde(default)]
    shared_chat_delete: Option<ModDelete>,
}

#[derive(Debug, Default, Deserialize)]
struct ModTarget {
    #[serde(default, deserialize_with = "null_default")]
    user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    user_name: String,
    #[serde(default, deserialize_with = "null_default")]
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ModTimeout {
    #[serde(flatten)]
    target: ModTarget,
    #[serde(default, deserialize_with = "null_default")]
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct ModDelete {
    #[serde(flatten)]
    target: ModTarget,
    #[serde(default, deserialize_with = "null_default")]
    message_id: String,
    #[serde(default, deserialize_with = "null_default")]
    message_body: String,
}

#[derive(Debug, Deserialize)]
struct ModRaid {
    #[serde(flatten)]
    target: ModTarget,
    #[serde(default)]
    viewer_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ModSlow {
    #[serde(default)]
    wait_time_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ModFollowers {
    #[serde(default)]
    follow_duration_minutes: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ModTerms {
    #[serde(default, deserialize_with = "null_default")]
    terms: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ModUnbanRequest {
    #[serde(flatten)]
    target: ModTarget,
    #[serde(default, deserialize_with = "null_default")]
    moderator_message: String,
}

fn mod_action(
    event: TwitchModerateEvent,
    message_timestamp: &str,
) -> Result<ModAction, ParseError> {
    let timestamp = parse_platform_ts(message_timestamp)?;
    let mut out = ModAction {
        channel_id: event.broadcaster_user_id,
        timestamp,
        moderator_login: event.moderator_user_login,
        moderator_name: event.moderator_user_name,
        action: event.action,
        ..ModAction::default()
    };
    let mut set_target = |t: ModTarget| {
        out.target_user_id = t.user_id;
        out.target_user_login = t.user_login;
        out.target_user_name = t.user_name;
        out.reason = t.reason;
    };
    let plain = [
        event.ban,
        event.unban,
        event.untimeout,
        event.warn,
        event.mod_,
        event.unmod,
        event.vip,
        event.unvip,
        event.unraid,
        event.shared_chat_ban,
        event.shared_chat_unban,
        event.shared_chat_untimeout,
    ];
    if let Some(t) = plain.into_iter().flatten().next() {
        set_target(t);
    }
    if let Some(t) = event.timeout.or(event.shared_chat_timeout) {
        let expires = chrono::DateTime::parse_from_rfc3339(&t.expires_at)
            .ok()
            .map(|e| e.timestamp_millis());
        set_target(t.target);
        out.duration_seconds = expires.map(|e| ((e - timestamp).max(0) / 1000) as u64);
    }
    if let Some(d) = event.delete.or(event.shared_chat_delete) {
        set_target(d.target);
        out.message_id = d.message_id;
        out.message_body = d.message_body;
    }
    if let Some(r) = event.raid {
        set_target(r.target);
        out.viewer_count = r.viewer_count;
    }
    if let Some(u) = event.unban_request {
        set_target(u.target);
        out.moderator_message = u.moderator_message;
    }
    out.wait_time_seconds = event.slow.and_then(|s| s.wait_time_seconds);
    out.follow_duration_minutes = event.followers.and_then(|f| f.follow_duration_minutes);
    out.terms = event.automod_terms.map(|t| t.terms).unwrap_or_default();
    Ok(out)
}

/// What one Twitch EventSub notification turned into.
#[derive(Debug, Clone)]
pub enum TwitchItem {
    Message(Box<UnifiedMessage>),
    Event(ChatEvent),
}

#[derive(Debug, Deserialize)]
struct TwitchNoticeEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    chatter_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    chatter_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    chatter_user_name: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    badges: Vec<TwitchBadge>,
    #[serde(default, deserialize_with = "null_default")]
    system_message: String,
    message_id: String,
    #[serde(default)]
    message: Option<TwitchChatMessage>,
    #[serde(default, deserialize_with = "null_default")]
    notice_type: String,
}

#[derive(Debug, Deserialize)]
struct TwitchDeleteEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    target_user_id: String,
    message_id: String,
}

#[derive(Debug, Deserialize)]
struct TwitchClearUserEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    target_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    target_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    target_user_name: String,
}

#[derive(Debug, Deserialize)]
struct TwitchClearEvent {
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
}

pub(crate) fn badge_flags(badges: &[Badge]) -> (bool, bool, bool) {
    let is_broadcaster = badges.iter().any(|b| b.set_id == "broadcaster");
    let is_mod = is_broadcaster || badges.iter().any(|b| b.set_id == "moderator");
    let is_subscriber = badges
        .iter()
        .any(|b| b.set_id == "subscriber" || b.set_id == "founder");
    (is_broadcaster, is_mod, is_subscriber)
}

fn convert_badges(badges: Vec<TwitchBadge>) -> Vec<Badge> {
    badges
        .into_iter()
        .map(|b| Badge {
            set_id: b.set_id,
            id: b.id,
        })
        .collect()
}

/// Parses a raw Twitch EventSub envelope into a [`TwitchItem`] when the
/// envelope is a notification for one of the chat subscriptions:
/// `channel.chat.message` and `channel.chat.notification` become messages,
/// `channel.chat.message_delete`, `channel.chat.clear_user_messages` and
/// `channel.chat.clear` become events.
///
/// Returns `Ok(None)` for any other envelope shape: keepalives, reconnects,
/// revocations, notifications for other subscription types, or payloads that
/// are missing the nested `subscription`/`event` fields. Those are not parse
/// errors; the drain loop filters them out silently.
///
/// Defensive parsing per `docs/stability.md`: no `unwrap` on external data,
/// unknown fields are ignored via serde, missing optional fields default.
pub fn parse_twitch_envelope(bytes: &[u8]) -> Result<Option<TwitchItem>, ParseError> {
    let envelope: TwitchEnvelope = serde_json::from_slice(bytes)?;

    if envelope.metadata.message_type != "notification" {
        return Ok(None);
    }

    let Some(payload) = envelope.payload else {
        return Ok(None);
    };
    let Some(subscription) = payload.subscription else {
        return Ok(None);
    };
    let Some(event_value) = payload.event else {
        return Ok(None);
    };
    let stamp = &envelope.metadata.message_timestamp;

    let item = match subscription.subscription_type.as_str() {
        "channel.chat.message" => {
            let event: TwitchChatEvent = serde_json::from_value(event_value)?;
            TwitchItem::Message(Box::new(chat_message(event, stamp)?))
        }
        "channel.chat.notification" => {
            let event: TwitchNoticeEvent = serde_json::from_value(event_value)?;
            TwitchItem::Message(Box::new(chat_notice(event, stamp)?))
        }
        "channel.chat.message_delete" => {
            let event: TwitchDeleteEvent = serde_json::from_value(event_value)?;
            TwitchItem::Event(ChatEvent::MessageDeleted {
                channel_id: event.broadcaster_user_id,
                message_id: event.message_id,
                target_user_id: event.target_user_id,
            })
        }
        "channel.chat.clear_user_messages" => {
            let event: TwitchClearUserEvent = serde_json::from_value(event_value)?;
            TwitchItem::Event(ChatEvent::UserCleared {
                channel_id: event.broadcaster_user_id,
                target_user_id: event.target_user_id,
                target_user_login: event.target_user_login,
                target_user_name: event.target_user_name,
            })
        }
        "channel.chat.clear" => {
            let event: TwitchClearEvent = serde_json::from_value(event_value)?;
            TwitchItem::Event(ChatEvent::ChatCleared {
                channel_id: event.broadcaster_user_id,
            })
        }
        "channel.moderate" => {
            let event: TwitchModerateEvent = serde_json::from_value(event_value)?;
            TwitchItem::Event(ChatEvent::ModAction(Box::new(mod_action(event, stamp)?)))
        }
        "automod.message.hold" => {
            let event: TwitchAutomodHoldEvent = serde_json::from_value(event_value)?;
            TwitchItem::Event(ChatEvent::AutomodHeld(Box::new(held_message(
                event, stamp,
            )?)))
        }
        "automod.message.update" => {
            let event: TwitchAutomodUpdateEvent = serde_json::from_value(event_value)?;
            // The reference lists the statuses capitalized while its
            // example payload sends them lowercase.
            TwitchItem::Event(ChatEvent::AutomodResolved {
                channel_id: event.broadcaster_user_id,
                message_id: event.message_id,
                status: event.status.to_ascii_lowercase(),
                moderator_login: event.moderator_user_login,
                moderator_name: event.moderator_user_name,
            })
        }
        t @ ("channel.poll.begin" | "channel.poll.progress" | "channel.poll.end") => {
            TwitchItem::Event(ChatEvent::PollUpdate(Box::new(poll_from_event(
                t,
                event_value,
            )?)))
        }
        t @ ("channel.prediction.begin"
        | "channel.prediction.progress"
        | "channel.prediction.lock"
        | "channel.prediction.end") => TwitchItem::Event(ChatEvent::PredictionUpdate(Box::new(
            prediction_from_event(t, event_value)?,
        ))),
        "channel.ad_break.begin" => TwitchItem::Event(ChatEvent::AdBreak(Box::new(
            ad_break_from_event(event_value)?,
        ))),
        _ => return Ok(None),
    };
    Ok(Some(item))
}

pub(crate) fn parse_platform_ts(message_timestamp: &str) -> Result<i64, ParseError> {
    Ok(chrono::DateTime::parse_from_rfc3339(message_timestamp)
        .map_err(ParseError::Timestamp)?
        .timestamp_millis())
}

fn chat_message(
    event: TwitchChatEvent,
    message_timestamp: &str,
) -> Result<UnifiedMessage, ParseError> {
    let platform_ts = parse_platform_ts(message_timestamp)?;
    let arrival_time = chrono::Utc::now().timestamp_millis();
    let badges = convert_badges(event.badges);
    let (is_broadcaster, is_mod, is_subscriber) = badge_flags(&badges);

    Ok(UnifiedMessage {
        id: event.message_id,
        platform: Platform::Twitch,
        timestamp: platform_ts,
        arrival_time,
        effective_ts: 0,
        arrival_seq: 0,
        username: event.chatter_user_login,
        display_name: event.chatter_user_name,
        platform_user_id: event.chatter_user_id,
        channel_id: event.broadcaster_user_id,
        message_text: event.message.text,
        badges,
        is_mod,
        is_subscriber,
        is_broadcaster,
        color: event.color,
        reply_to: event.reply.as_ref().map(|r| r.parent_message_id.clone()),
        reply_parent: event.reply.map(|r| ReplyParent {
            user_login: r.parent_user_login,
            user_name: r.parent_user_name,
            body: r.parent_message_body,
            thread_id: r.thread_message_id,
        }),
        notice: None,
        emote_spans: Vec::new(),
    })
}

fn chat_notice(
    event: TwitchNoticeEvent,
    message_timestamp: &str,
) -> Result<UnifiedMessage, ParseError> {
    let platform_ts = parse_platform_ts(message_timestamp)?;
    let arrival_time = chrono::Utc::now().timestamp_millis();
    let badges = convert_badges(event.badges);
    let (is_broadcaster, is_mod, is_subscriber) = badge_flags(&badges);

    Ok(UnifiedMessage {
        id: event.message_id,
        platform: Platform::Twitch,
        timestamp: platform_ts,
        arrival_time,
        effective_ts: 0,
        arrival_seq: 0,
        username: event.chatter_user_login,
        display_name: event.chatter_user_name,
        platform_user_id: event.chatter_user_id,
        channel_id: event.broadcaster_user_id,
        message_text: event.message.map(|m| m.text).unwrap_or_default(),
        badges,
        is_mod,
        is_subscriber,
        is_broadcaster,
        color: event.color,
        reply_to: None,
        reply_parent: None,
        notice: Some(ChatNotice {
            notice_type: event.notice_type,
            system_message: event.system_message,
        }),
        emote_spans: Vec::new(),
    })
}

// --- YouTube protojson deserialization types (private, narrow) ---

#[derive(Debug, Deserialize)]
struct YouTubeMessage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    snippet: Option<YouTubeSnippet>,
    #[serde(default)]
    author_details: Option<YouTubeAuthorDetails>,
}

#[derive(Debug, Deserialize)]
struct YouTubeSnippet {
    #[serde(default, rename = "type")]
    msg_type: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    live_chat_id: Option<String>,
    #[serde(default)]
    display_message: Option<String>,
    #[serde(default)]
    text_message_details: Option<YouTubeTextDetails>,
}

#[derive(Debug, Deserialize)]
struct YouTubeTextDetails {
    #[serde(default)]
    message_text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YouTubeAuthorDetails {
    #[serde(default)]
    channel_id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    is_chat_owner: Option<bool>,
    #[serde(default)]
    is_chat_moderator: Option<bool>,
    #[serde(default)]
    is_chat_sponsor: Option<bool>,
}

/// Parses a protojson-serialized YouTube `LiveChatMessage` into a
/// [`UnifiedMessage`]. Returns `Ok(None)` for non-text message types
/// (super chats, bans, etc. are future work).
pub fn parse_youtube_message(bytes: &[u8]) -> Result<Option<UnifiedMessage>, ParseError> {
    let msg: YouTubeMessage = serde_json::from_slice(bytes)?;

    let snippet = match msg.snippet {
        Some(s) => s,
        None => return Ok(None),
    };

    // Only handle text messages for now
    let msg_type = snippet.msg_type.as_deref().unwrap_or("");
    if msg_type != "TEXT_MESSAGE_EVENT" {
        return Ok(None);
    }

    let text = match snippet
        .text_message_details
        .and_then(|d| d.message_text)
        .or(snippet.display_message)
        .filter(|s| !s.is_empty())
    {
        Some(t) => t,
        None => return Ok(None),
    };

    let author = match msg.author_details {
        Some(a) => a,
        None => return Ok(None),
    };

    let channel_id = match author.channel_id.filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => return Ok(None),
    };
    let display_name = match author.display_name.filter(|s| !s.is_empty()) {
        Some(d) => d,
        None => return Ok(None),
    };
    let id = match msg.id.filter(|s| !s.is_empty()) {
        Some(i) => i,
        None => return Ok(None),
    };

    let is_broadcaster = author.is_chat_owner.unwrap_or(false);
    let is_mod = is_broadcaster || author.is_chat_moderator.unwrap_or(false);
    let is_subscriber = author.is_chat_sponsor.unwrap_or(false);

    let mut badges = Vec::with_capacity(2);
    if is_broadcaster {
        badges.push(Badge {
            set_id: String::from("youtube/owner"),
            id: String::from("1"),
        });
    } else if author.is_chat_moderator.unwrap_or(false) {
        badges.push(Badge {
            set_id: String::from("youtube/moderator"),
            id: String::from("1"),
        });
    }
    if is_subscriber {
        badges.push(Badge {
            set_id: String::from("youtube/member"),
            id: String::from("1"),
        });
    }

    let color = if is_broadcaster {
        Some(String::from("#ffd600"))
    } else if author.is_chat_moderator.unwrap_or(false) {
        Some(String::from("#5e84f1"))
    } else if is_subscriber {
        Some(String::from("#2ba640"))
    } else {
        None
    };

    let timestamp = match snippet.published_at.as_deref() {
        Some(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map_err(ParseError::Timestamp)?
            .timestamp_millis(),
        None => chrono::Utc::now().timestamp_millis(),
    };

    Ok(Some(UnifiedMessage {
        id,
        platform: Platform::YouTube,
        timestamp,
        arrival_time: chrono::Utc::now().timestamp_millis(),
        effective_ts: 0,
        arrival_seq: 0,
        username: channel_id.clone(),
        display_name,
        platform_user_id: channel_id,
        channel_id: snippet.live_chat_id.unwrap_or_default(),
        message_text: text,
        badges,
        is_mod,
        is_subscriber,
        is_broadcaster,
        color,
        reply_to: None,
        reply_parent: None,
        notice: None,
        emote_spans: Vec::new(),
    }))
}

// --- Kick Pusher deserialization types (private, narrow) ---

#[derive(Debug, Deserialize)]
struct KickPusherEvent {
    event: String,
    #[serde(default)]
    data: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KickChatMessage {
    id: String,
    #[serde(default)]
    chatroom_id: Option<i64>,
    content: String,
    created_at: String,
    sender: KickSender,
}

#[derive(Debug, Deserialize)]
struct KickSender {
    id: i64,
    username: String,
    #[serde(default)]
    identity: Option<KickIdentity>,
}

#[derive(Debug, Deserialize)]
struct KickIdentity {
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    badges: Vec<KickBadge>,
}

#[derive(Debug, Deserialize)]
struct KickBadge {
    #[serde(rename = "type")]
    badge_type: String,
}

/// Parses a raw Kick Pusher channel event into a [`UnifiedMessage`] when the
/// event is a `ChatMessageEvent`.
///
/// Returns `Ok(None)` for non-chat events. The Pusher `data` field is a
/// double-encoded JSON string containing the actual chat message payload.
pub fn parse_kick_event(bytes: &[u8]) -> Result<Option<UnifiedMessage>, ParseError> {
    let event: KickPusherEvent = serde_json::from_slice(bytes)?;

    if !event.event.contains("ChatMessageEvent") {
        return Ok(None);
    }

    let Some(data_str) = event.data else {
        return Ok(None);
    };

    let msg: KickChatMessage = serde_json::from_str(&data_str)?;

    let platform_ts = chrono::DateTime::parse_from_rfc3339(&msg.created_at)
        .or_else(|_| {
            // Kick sometimes sends timestamps without timezone offset
            chrono::NaiveDateTime::parse_from_str(&msg.created_at, "%Y-%m-%dT%H:%M:%S")
                .map(|naive| naive.and_utc().fixed_offset())
        })
        .map_err(ParseError::Timestamp)?
        .timestamp_millis();
    let arrival_time = chrono::Utc::now().timestamp_millis();

    let identity = msg.sender.identity.unwrap_or(KickIdentity {
        color: None,
        badges: Vec::new(),
    });

    let is_broadcaster = identity
        .badges
        .iter()
        .any(|b| b.badge_type == "broadcaster");
    let is_mod = is_broadcaster || identity.badges.iter().any(|b| b.badge_type == "moderator");
    let is_subscriber = identity.badges.iter().any(|b| b.badge_type == "subscriber");

    let badges: Vec<Badge> = identity
        .badges
        .into_iter()
        .map(|b| Badge {
            set_id: format!("kick/{}", b.badge_type),
            id: String::from("1"),
        })
        .collect();

    Ok(Some(UnifiedMessage {
        id: msg.id,
        platform: Platform::Kick,
        timestamp: platform_ts,
        arrival_time,
        effective_ts: 0,
        arrival_seq: 0,
        username: msg.sender.username.clone(),
        display_name: msg.sender.username,
        platform_user_id: msg.sender.id.to_string(),
        channel_id: msg.chatroom_id.map(|id| id.to_string()).unwrap_or_default(),
        message_text: msg.content,
        badges,
        is_mod,
        is_subscriber,
        is_broadcaster,
        color: identity.color,
        reply_to: None,
        reply_parent: None,
        notice: None,
        emote_spans: Vec::new(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(bytes: &[u8]) -> UnifiedMessage {
        match parse_twitch_envelope(bytes).unwrap().unwrap() {
            TwitchItem::Message(m) => *m,
            TwitchItem::Event(_) => panic!("expected a message"),
        }
    }

    const VIEWER_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "meta-1",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:11:47.492Z"
        },
        "payload": {
            "subscription": {
                "id": "sub-1",
                "status": "enabled",
                "type": "channel.chat.message",
                "version": "1",
                "cost": 0
            },
            "event": {
                "broadcaster_user_id": "1971641",
                "broadcaster_user_login": "streamer",
                "broadcaster_user_name": "streamer",
                "chatter_user_id": "4145994",
                "chatter_user_login": "viewer32",
                "chatter_user_name": "viewer32",
                "message_id": "cc106a89-1814-919d-454c-f4f2f970aae7",
                "message": {
                    "text": "Hi chat",
                    "fragments": []
                },
                "color": "#00FF7F",
                "badges": [],
                "message_type": "text"
            }
        }
    }"##;

    const MOD_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "meta-2",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:11:48.100Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.message" },
            "event": {
                "broadcaster_user_id": "1",
                "chatter_user_id": "99",
                "chatter_user_login": "the_mod",
                "chatter_user_name": "TheMod",
                "message_id": "m-1",
                "message": { "text": "!ban spammer" },
                "color": "#FF0000",
                "badges": [
                    { "set_id": "moderator", "id": "1", "info": "" },
                    { "set_id": "subscriber", "id": "6", "info": "6" }
                ]
            }
        }
    }"##;

    const BROADCASTER_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "meta-3",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:12:00.000Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.message" },
            "event": {
                "broadcaster_user_id": "1",
                "chatter_user_id": "1",
                "chatter_user_login": "streamer",
                "chatter_user_name": "Streamer",
                "message_id": "b-1",
                "message": { "text": "welcome everyone" },
                "badges": [{ "set_id": "broadcaster", "id": "1", "info": "" }]
            }
        }
    }"##;

    const REPLY_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "meta-4",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:12:05.250Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.message" },
            "event": {
                "chatter_user_id": "42",
                "chatter_user_login": "replier",
                "chatter_user_name": "Replier",
                "message_id": "r-1",
                "message": { "text": "lol" },
                "reply": {
                    "parent_message_id": "parent-abc",
                    "parent_user_id": "1",
                    "parent_user_login": "streamer",
                    "parent_user_name": "Streamer",
                    "parent_message_body": "original take",
                    "thread_message_id": "parent-abc"
                }
            }
        }
    }"##;

    const KEEPALIVE: &[u8] = br##"{
        "metadata": {
            "message_id": "ka-1",
            "message_type": "session_keepalive",
            "message_timestamp": "2023-11-06T18:11:49.000Z"
        },
        "payload": {}
    }"##;

    const OTHER_NOTIFICATION: &[u8] = br##"{
        "metadata": {
            "message_id": "on-1",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:11:50.000Z"
        },
        "payload": {
            "subscription": { "type": "channel.follow" },
            "event": {}
        }
    }"##;

    #[test]
    fn parses_viewer_message() {
        let msg = message(VIEWER_MSG);
        assert_eq!(msg.id, "cc106a89-1814-919d-454c-f4f2f970aae7");
        assert_eq!(msg.channel_id, "1971641");
        assert_eq!(msg.username, "viewer32");
        assert_eq!(msg.display_name, "viewer32");
        assert_eq!(msg.platform_user_id, "4145994");
        assert_eq!(msg.message_text, "Hi chat");
        assert_eq!(msg.color.as_deref(), Some("#00FF7F"));
        assert!(matches!(msg.platform, Platform::Twitch));
        assert!(!msg.is_mod);
        assert!(!msg.is_subscriber);
        assert!(!msg.is_broadcaster);
        assert!(msg.reply_to.is_none());
        assert!(msg.timestamp > 0);
        assert!(msg.arrival_time >= msg.timestamp || msg.arrival_time > 0);
    }

    #[test]
    fn parses_moderator_flags() {
        let msg = message(MOD_MSG);
        assert!(msg.is_mod);
        assert!(msg.is_subscriber);
        assert!(!msg.is_broadcaster);
        assert_eq!(msg.badges.len(), 2);
    }

    #[test]
    fn broadcaster_implies_mod() {
        let msg = message(BROADCASTER_MSG);
        assert!(msg.is_broadcaster);
        assert!(msg.is_mod);
    }

    #[test]
    fn parses_reply_parent() {
        let msg = message(REPLY_MSG);
        assert_eq!(msg.reply_to.as_deref(), Some("parent-abc"));
        assert_eq!(
            msg.reply_parent,
            Some(ReplyParent {
                user_login: "streamer".into(),
                user_name: "Streamer".into(),
                body: "original take".into(),
                thread_id: "parent-abc".into(),
            })
        );
    }

    #[test]
    fn keepalive_returns_none() {
        let result = parse_twitch_envelope(KEEPALIVE).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn other_notification_types_return_none() {
        let result = parse_twitch_envelope(OTHER_NOTIFICATION).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn malformed_json_returns_err() {
        let err = parse_twitch_envelope(b"not json").unwrap_err();
        assert!(matches!(err, ParseError::Json(_)));
    }

    #[test]
    fn bad_timestamp_returns_err() {
        let bytes: &[u8] = br##"{
            "metadata": {
                "message_id": "m",
                "message_type": "notification",
                "message_timestamp": "not a date"
            },
            "payload": {
                "subscription": { "type": "channel.chat.message" },
                "event": {
                    "chatter_user_id": "1",
                    "chatter_user_login": "u",
                    "chatter_user_name": "U",
                    "message_id": "m",
                    "message": { "text": "x" }
                }
            }
        }"##;
        let err = parse_twitch_envelope(bytes).unwrap_err();
        assert!(matches!(err, ParseError::Timestamp(_)));
    }

    #[test]
    fn parse_error_display_and_source() {
        let err = parse_twitch_envelope(b"}{").unwrap_err();
        let _ = err.to_string();
        assert!(std::error::Error::source(&err).is_some());
    }

    // --- YouTube parser tests ---

    const YT_TEXT_MSG: &[u8] = br##"{
        "id": "yt-msg-1",
        "snippet": {
            "type": "TEXT_MESSAGE_EVENT",
            "live_chat_id": "chat123",
            "author_channel_id": "UC_abc",
            "published_at": "2024-06-15T12:30:00Z",
            "has_display_content": true,
            "display_message": "hello youtube",
            "text_message_details": {
                "message_text": "hello youtube"
            }
        },
        "author_details": {
            "channel_id": "UC_abc",
            "display_name": "TestViewer",
            "is_verified": false,
            "is_chat_owner": false,
            "is_chat_sponsor": false,
            "is_chat_moderator": false
        }
    }"##;

    const YT_OWNER_MSG: &[u8] = br##"{
        "id": "yt-msg-2",
        "snippet": {
            "type": "TEXT_MESSAGE_EVENT",
            "published_at": "2024-06-15T12:31:00Z",
            "text_message_details": { "message_text": "welcome all" }
        },
        "author_details": {
            "channel_id": "UC_owner",
            "display_name": "Streamer",
            "is_chat_owner": true,
            "is_chat_moderator": false,
            "is_chat_sponsor": false
        }
    }"##;

    const YT_MOD_MSG: &[u8] = br##"{
        "id": "yt-msg-3",
        "snippet": {
            "type": "TEXT_MESSAGE_EVENT",
            "published_at": "2024-06-15T12:32:00Z",
            "text_message_details": { "message_text": "calm down chat" }
        },
        "author_details": {
            "channel_id": "UC_mod",
            "display_name": "ModUser",
            "is_chat_owner": false,
            "is_chat_moderator": true,
            "is_chat_sponsor": true
        }
    }"##;

    const YT_SUPER_CHAT: &[u8] = br##"{
        "id": "yt-sc-1",
        "snippet": {
            "type": "SUPER_CHAT_EVENT",
            "published_at": "2024-06-15T12:33:00Z",
            "display_message": "$5.00",
            "super_chat_details": { "amount_micros": 5000000, "currency": "USD" }
        },
        "author_details": {
            "channel_id": "UC_donor",
            "display_name": "BigDonor"
        }
    }"##;

    #[test]
    fn parses_youtube_text_message() {
        let msg = parse_youtube_message(YT_TEXT_MSG).unwrap().unwrap();
        assert_eq!(msg.id, "yt-msg-1");
        assert!(matches!(msg.platform, Platform::YouTube));
        assert_eq!(msg.display_name, "TestViewer");
        assert_eq!(msg.platform_user_id, "UC_abc");
        assert_eq!(msg.message_text, "hello youtube");
        assert!(!msg.is_mod);
        assert!(!msg.is_subscriber);
        assert!(!msg.is_broadcaster);
        assert!(msg.color.is_none());
        assert!(msg.badges.is_empty());
        assert!(msg.timestamp > 0);
    }

    #[test]
    fn youtube_owner_implies_mod() {
        let msg = parse_youtube_message(YT_OWNER_MSG).unwrap().unwrap();
        assert!(msg.is_broadcaster);
        assert!(msg.is_mod);
        assert_eq!(msg.display_name, "Streamer");
        assert_eq!(msg.badges.len(), 1);
        assert_eq!(msg.badges[0].set_id, "youtube/owner");
        assert_eq!(msg.badges[0].id, "1");
        assert_eq!(msg.color.as_deref(), Some("#ffd600"));
    }

    #[test]
    fn youtube_moderator_flags() {
        let msg = parse_youtube_message(YT_MOD_MSG).unwrap().unwrap();
        assert!(msg.is_mod);
        assert!(msg.is_subscriber); // is_chat_sponsor maps to subscriber
        assert!(!msg.is_broadcaster);
        assert_eq!(msg.badges.len(), 2);
        assert_eq!(msg.badges[0].set_id, "youtube/moderator");
        assert_eq!(msg.badges[1].set_id, "youtube/member");
        assert_eq!(msg.color.as_deref(), Some("#5e84f1"));
    }

    #[test]
    fn youtube_non_text_returns_none() {
        let result = parse_youtube_message(YT_SUPER_CHAT).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn youtube_malformed_json_returns_err() {
        let err = parse_youtube_message(b"not json").unwrap_err();
        assert!(matches!(err, ParseError::Json(_)));
    }

    #[test]
    fn youtube_missing_snippet_returns_none() {
        let msg = br#"{"id":"x","author_details":{"channel_id":"c","display_name":"d"}}"#;
        assert!(parse_youtube_message(msg).unwrap().is_none());
    }

    #[test]
    fn youtube_missing_text_returns_none() {
        let msg = br##"{
            "id": "yt-empty",
            "snippet": {
                "type": "TEXT_MESSAGE_EVENT",
                "published_at": "2024-06-15T12:30:00Z"
            },
            "author_details": { "channel_id": "c", "display_name": "d" }
        }"##;
        assert!(parse_youtube_message(msg).unwrap().is_none());
    }

    #[test]
    fn youtube_empty_text_returns_none() {
        let msg = br##"{
            "id": "yt-empty",
            "snippet": {
                "type": "TEXT_MESSAGE_EVENT",
                "published_at": "2024-06-15T12:30:00Z",
                "text_message_details": { "message_text": "" }
            },
            "author_details": { "channel_id": "c", "display_name": "d" }
        }"##;
        assert!(parse_youtube_message(msg).unwrap().is_none());
    }

    #[test]
    fn youtube_missing_author_returns_none() {
        let msg = br##"{
            "id": "yt-1",
            "snippet": {
                "type": "TEXT_MESSAGE_EVENT",
                "published_at": "2024-06-15T12:30:00Z",
                "text_message_details": { "message_text": "hi" }
            }
        }"##;
        assert!(parse_youtube_message(msg).unwrap().is_none());
    }

    #[test]
    fn youtube_missing_id_returns_none() {
        let msg = br##"{
            "snippet": {
                "type": "TEXT_MESSAGE_EVENT",
                "published_at": "2024-06-15T12:30:00Z",
                "text_message_details": { "message_text": "hi" }
            },
            "author_details": { "channel_id": "c", "display_name": "d" }
        }"##;
        assert!(parse_youtube_message(msg).unwrap().is_none());
    }

    #[test]
    fn youtube_bad_timestamp_returns_err() {
        let msg = br##"{
            "id": "yt-1",
            "snippet": {
                "type": "TEXT_MESSAGE_EVENT",
                "published_at": "not a date",
                "text_message_details": { "message_text": "hi" }
            },
            "author_details": { "channel_id": "c", "display_name": "d" }
        }"##;
        let err = parse_youtube_message(msg).unwrap_err();
        assert!(matches!(err, ParseError::Timestamp(_)));
    }

    #[test]
    fn youtube_missing_timestamp_uses_now() {
        let msg = br##"{
            "id": "yt-1",
            "snippet": {
                "type": "TEXT_MESSAGE_EVENT",
                "text_message_details": { "message_text": "hi" }
            },
            "author_details": { "channel_id": "c", "display_name": "d" }
        }"##;
        let parsed = parse_youtube_message(msg).unwrap().unwrap();
        assert!(parsed.timestamp > 0);
    }

    // --- Kick parser tests ---

    const KICK_CHAT_EVENT: &[u8] = br##"{
        "event": "App\\Events\\ChatMessageEvent",
        "data": "{\"id\":\"msg-k1\",\"chatroom_id\":100,\"content\":\"hello kick\",\"type\":\"message\",\"created_at\":\"2025-06-01T12:00:00Z\",\"sender\":{\"id\":42,\"username\":\"viewer1\",\"slug\":\"viewer1\",\"identity\":{\"color\":\"#FF5733\",\"badges\":[]}}}",
        "channel": "chatrooms.100.v2"
    }"##;

    const KICK_MOD_MSG: &[u8] = br##"{
        "event": "App\\Events\\ChatMessageEvent",
        "data": "{\"id\":\"msg-k2\",\"chatroom_id\":100,\"content\":\"!ban spammer\",\"type\":\"message\",\"created_at\":\"2025-06-01T12:01:00Z\",\"sender\":{\"id\":99,\"username\":\"the_mod\",\"slug\":\"the_mod\",\"identity\":{\"color\":\"#FF0000\",\"badges\":[{\"type\":\"moderator\",\"text\":\"Moderator\"},{\"type\":\"subscriber\",\"text\":\"Subscriber\"}]}}}",
        "channel": "chatrooms.100.v2"
    }"##;

    const KICK_OTHER_EVENT: &[u8] = br##"{
        "event": "App\\Events\\UserBannedEvent",
        "data": "{}",
        "channel": "chatrooms.100.v2"
    }"##;

    #[test]
    fn parses_kick_chat_message() {
        let msg = parse_kick_event(KICK_CHAT_EVENT).unwrap().unwrap();
        assert_eq!(msg.id, "msg-k1");
        assert_eq!(msg.username, "viewer1");
        assert_eq!(msg.display_name, "viewer1");
        assert_eq!(msg.platform_user_id, "42");
        assert_eq!(msg.message_text, "hello kick");
        assert_eq!(msg.color.as_deref(), Some("#FF5733"));
        assert!(matches!(msg.platform, Platform::Kick));
        assert!(!msg.is_mod);
        assert!(!msg.is_subscriber);
        assert!(!msg.is_broadcaster);
        assert!(msg.timestamp > 0);
    }

    #[test]
    fn parses_kick_moderator_flags() {
        let msg = parse_kick_event(KICK_MOD_MSG).unwrap().unwrap();
        assert!(msg.is_mod);
        assert!(msg.is_subscriber);
        assert!(!msg.is_broadcaster);
        assert_eq!(msg.badges.len(), 2);
        assert_eq!(msg.badges[0].set_id, "kick/moderator");
        assert_eq!(msg.badges[0].id, "1");
        assert_eq!(msg.badges[1].set_id, "kick/subscriber");
        assert_eq!(msg.badges[1].id, "1");
    }

    #[test]
    fn kick_non_chat_event_returns_none() {
        let result = parse_kick_event(KICK_OTHER_EVENT).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn kick_malformed_json_returns_err() {
        let err = parse_kick_event(b"not json").unwrap_err();
        assert!(matches!(err, ParseError::Json(_)));
    }

    fn fake_msg(timestamp: i64, arrival_time: i64) -> UnifiedMessage {
        UnifiedMessage {
            id: String::new(),
            platform: Platform::Twitch,
            timestamp,
            arrival_time,
            effective_ts: 0,
            arrival_seq: 0,
            username: String::new(),
            display_name: String::new(),
            platform_user_id: String::new(),
            channel_id: String::new(),
            message_text: String::new(),
            badges: Vec::new(),
            is_mod: false,
            is_subscriber: false,
            is_broadcaster: false,
            color: None,
            reply_to: None,
            reply_parent: None,
            notice: None,
            emote_spans: Vec::new(),
        }
    }

    #[test]
    fn snap_uses_platform_ts_when_within_window() {
        // Exactly at 0 delta → trust platform.
        assert_eq!(compute_effective_ts(1_000, 1_000), 1_000);
        // Inside window on either side.
        assert_eq!(compute_effective_ts(1_000, 1_400), 1_000);
        assert_eq!(compute_effective_ts(1_400, 1_000), 1_400);
    }

    #[test]
    fn snap_boundary_inclusive() {
        // Delta exactly at SNAP_WINDOW_MS still trusts platform.
        assert_eq!(compute_effective_ts(1_000, 1_000 + SNAP_WINDOW_MS), 1_000);
        assert_eq!(
            compute_effective_ts(1_000 + SNAP_WINDOW_MS, 1_000),
            1_000 + SNAP_WINDOW_MS
        );
    }

    #[test]
    fn snap_falls_back_to_arrival_when_outside_window() {
        // One ms past the window → arrival wins.
        assert_eq!(
            compute_effective_ts(1_000, 1_000 + SNAP_WINDOW_MS + 1),
            1_000 + SNAP_WINDOW_MS + 1
        );
        // Negative delta past the window also flips to arrival.
        assert_eq!(compute_effective_ts(10_000, 1_000), 1_000);
    }

    #[test]
    fn assign_arrival_seqs_assigns_in_order_and_advances_counter() {
        let mut batch = vec![fake_msg(0, 0), fake_msg(0, 0), fake_msg(0, 0)];
        let mut counter: u64 = 100;
        assign_arrival_seqs(&mut batch, &mut counter);
        assert_eq!(batch[0].arrival_seq, 100);
        assert_eq!(batch[1].arrival_seq, 101);
        assert_eq!(batch[2].arrival_seq, 102);
        assert_eq!(counter, 103);
    }

    #[test]
    fn assign_arrival_seqs_continues_across_batches() {
        let mut counter: u64 = 0;
        let mut first = vec![fake_msg(0, 0), fake_msg(0, 0)];
        assign_arrival_seqs(&mut first, &mut counter);
        let mut second = vec![fake_msg(0, 0)];
        assign_arrival_seqs(&mut second, &mut counter);
        assert_eq!(first[0].arrival_seq, 0);
        assert_eq!(first[1].arrival_seq, 1);
        assert_eq!(second[0].arrival_seq, 2);
        assert_eq!(counter, 3);
    }

    #[test]
    fn assign_arrival_seqs_empty_batch_is_noop() {
        let mut batch: Vec<UnifiedMessage> = Vec::new();
        let mut counter: u64 = 7;
        assign_arrival_seqs(&mut batch, &mut counter);
        assert_eq!(counter, 7);
    }

    const NOTICE_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "n-1",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:12:05.250Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.notification" },
            "event": {
                "broadcaster_user_id": "1971641",
                "chatter_user_id": "49",
                "chatter_user_login": "subber",
                "chatter_user_name": "Subber",
                "chatter_is_anonymous": false,
                "color": "#FF0000",
                "badges": [{ "set_id": "subscriber", "id": "12", "info": "12" }],
                "system_message": "Subber subscribed at Tier 1. They've subscribed for 12 months!",
                "message_id": "notice-1",
                "message": { "text": "pog", "fragments": [] },
                "notice_type": "resub",
                "resub": { "cumulative_months": 12, "sub_tier": "1000" }
            }
        }
    }"##;

    const DELETE_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "d-1",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:12:05.250Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.message_delete" },
            "event": {
                "broadcaster_user_id": "1971641",
                "target_user_id": "42",
                "target_user_login": "replier",
                "target_user_name": "Replier",
                "message_id": "r-1"
            }
        }
    }"##;

    const CLEAR_USER_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "cu-1",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:12:05.250Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.clear_user_messages" },
            "event": {
                "broadcaster_user_id": "1971641",
                "target_user_id": "42",
                "target_user_login": "replier",
                "target_user_name": "Replier"
            }
        }
    }"##;

    const CLEAR_MSG: &[u8] = br##"{
        "metadata": {
            "message_id": "c-1",
            "message_type": "notification",
            "message_timestamp": "2023-11-06T18:12:05.250Z"
        },
        "payload": {
            "subscription": { "type": "channel.chat.clear" },
            "event": { "broadcaster_user_id": "1971641" }
        }
    }"##;

    fn event(bytes: &[u8]) -> ChatEvent {
        match parse_twitch_envelope(bytes).unwrap().unwrap() {
            TwitchItem::Event(e) => e,
            TwitchItem::Message(_) => panic!("expected an event"),
        }
    }

    #[test]
    fn tolerates_explicit_nulls_in_string_fields() {
        let chat = br##"{
            "metadata": { "message_type": "notification", "message_timestamp": "2023-11-06T18:12:05.250Z" },
            "payload": {
                "subscription": { "type": "channel.chat.message" },
                "event": {
                    "broadcaster_user_id": "1971641",
                    "chatter_user_id": "1",
                    "chatter_user_login": "a",
                    "chatter_user_name": null,
                    "message_id": "m-null",
                    "message": { "text": "hi", "fragments": [] },
                    "color": null,
                    "badges": null,
                    "reply": { "parent_message_id": "p", "parent_user_login": null, "parent_user_name": null, "parent_message_body": null },
                    "source_broadcaster_user_id": null
                }
            }
        }"##;
        let msg = message(chat);
        assert_eq!(msg.id, "m-null");
        assert_eq!(msg.display_name, "");
        assert!(msg.badges.is_empty());
        assert_eq!(msg.reply_parent.as_ref().map(|r| r.body.as_str()), Some(""));

        let notice = br##"{
            "metadata": { "message_type": "notification", "message_timestamp": "2023-11-06T18:12:05.250Z" },
            "payload": {
                "subscription": { "type": "channel.chat.notification" },
                "event": {
                    "broadcaster_user_id": "1971641",
                    "chatter_user_id": null,
                    "chatter_user_login": null,
                    "chatter_user_name": null,
                    "chatter_is_anonymous": true,
                    "color": null,
                    "badges": [],
                    "system_message": null,
                    "message_id": "n-null",
                    "message": { "text": null, "fragments": [] },
                    "notice_type": "community_sub_gift"
                }
            }
        }"##;
        let msg = message(notice);
        assert_eq!(msg.id, "n-null");
        assert_eq!(msg.message_text, "");
        assert_eq!(msg.notice.unwrap().notice_type, "community_sub_gift");
    }

    #[test]
    fn parses_notice_as_message_with_system_line() {
        let msg = message(NOTICE_MSG);
        assert_eq!(msg.id, "notice-1");
        assert_eq!(msg.username, "subber");
        assert_eq!(msg.message_text, "pog");
        assert!(msg.is_subscriber);
        assert_eq!(
            msg.notice,
            Some(ChatNotice {
                notice_type: "resub".into(),
                system_message: "Subber subscribed at Tier 1. They've subscribed for 12 months!"
                    .into(),
            })
        );
    }

    #[test]
    fn parses_moderation_events() {
        assert_eq!(
            event(DELETE_MSG),
            ChatEvent::MessageDeleted {
                channel_id: "1971641".into(),
                message_id: "r-1".into(),
                target_user_id: "42".into(),
            }
        );
        assert_eq!(
            event(CLEAR_USER_MSG),
            ChatEvent::UserCleared {
                channel_id: "1971641".into(),
                target_user_id: "42".into(),
                target_user_login: "replier".into(),
                target_user_name: "Replier".into(),
            }
        );
        assert_eq!(
            event(CLEAR_MSG),
            ChatEvent::ChatCleared {
                channel_id: "1971641".into(),
            }
        );
    }

    fn moderate(action: &str, body: &str) -> ModAction {
        let raw = format!(
            r##"{{
                "metadata": {{ "message_type": "notification", "message_timestamp": "2023-11-06T18:12:05.250Z" }},
                "payload": {{
                    "subscription": {{ "type": "channel.moderate", "version": "2" }},
                    "event": {{
                        "broadcaster_user_id": "1971641",
                        "broadcaster_user_login": "streamer",
                        "broadcaster_user_name": "Streamer",
                        "source_broadcaster_user_id": "1971641",
                        "source_broadcaster_user_name": null,
                        "moderator_user_id": "7",
                        "moderator_user_login": "modguy",
                        "moderator_user_name": "ModGuy",
                        "action": "{action}",
                        "ban": null, "timeout": null, "delete": null, "slow": null,
                        {body}
                    }}
                }}
            }}"##
        );
        match event(raw.as_bytes()) {
            ChatEvent::ModAction(a) => *a,
            other => panic!("expected mod action, got {other:?}"),
        }
    }

    #[test]
    fn parses_moderate_timeout_with_duration() {
        let a = moderate(
            "timeout",
            r#""timeout": {"user_id": "42", "user_login": "spammer", "user_name": "Spammer", "reason": "caps", "expires_at": "2023-11-06T18:22:05.250Z"}"#,
        );
        assert_eq!(a.moderator_login, "modguy");
        assert_eq!(a.target_user_login, "spammer");
        assert_eq!(a.reason, "caps");
        assert_eq!(a.duration_seconds, Some(600));
        assert_eq!(a.channel_id, "1971641");
    }

    #[test]
    fn parses_moderate_delete_slow_and_terms() {
        let d = moderate(
            "delete",
            r#""delete": {"user_id": "42", "user_login": "x", "user_name": "X", "message_id": "m-9", "message_body": "bad words"}"#,
        );
        assert_eq!(d.message_id, "m-9");
        assert_eq!(d.message_body, "bad words");
        assert_eq!(d.target_user_id, "42");

        let s = moderate("slow", r#""slow": {"wait_time_seconds": 30}"#);
        assert_eq!(s.wait_time_seconds, Some(30));
        assert!(s.target_user_id.is_empty());

        let t = moderate(
            "add_blocked_term",
            r#""automod_terms": {"action": "add", "list": "blocked", "terms": ["abc", "def"], "from_automod": false}"#,
        );
        assert_eq!(t.terms, vec!["abc", "def"]);

        let json = serde_json::to_value(ChatEvent::ModAction(Box::new(s))).unwrap();
        assert_eq!(json["kind"], "mod_action");
        assert_eq!(json["action"], "slow");
    }

    fn automod(sub_type: &str, body: &str) -> ChatEvent {
        let raw = format!(
            r##"{{
                "metadata": {{ "message_type": "notification", "message_timestamp": "2023-11-06T18:12:05.250Z" }},
                "payload": {{
                    "subscription": {{ "type": "{sub_type}", "version": "2" }},
                    "event": {{
                        "broadcaster_user_id": "1971641",
                        "broadcaster_user_login": "streamer",
                        "broadcaster_user_name": "Streamer",
                        "user_id": "42",
                        "user_login": "chatter",
                        "user_name": "Chatter",
                        "message_id": "held-1",
                        "message": {{ "text": "you are bad", "fragments": [{{ "type": "text", "text": "you are bad", "cheermote": null, "emote": null }}] }},
                        {body}
                    }}
                }}
            }}"##
        );
        event(raw.as_bytes())
    }

    #[test]
    fn parses_automod_hold_v2() {
        let e = automod(
            "automod.message.hold",
            r#""reason": "automod",
               "automod": { "category": "aggressive", "level": 2, "boundaries": [{ "start_pos": 8, "end_pos": 10 }] },
               "blocked_term": null,
               "held_at": "2023-11-06T18:12:04.000Z""#,
        );
        assert_eq!(
            e,
            ChatEvent::AutomodHeld(Box::new(HeldMessage {
                channel_id: "1971641".into(),
                message_id: "held-1".into(),
                user_id: "42".into(),
                user_login: "chatter".into(),
                user_name: "Chatter".into(),
                text: "you are bad".into(),
                reason: "automod".into(),
                category: "aggressive".into(),
                level: Some(2),
                held_at: 1_699_294_324_000,
            }))
        );
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "automod_held");
        assert_eq!(json["level"], 2);
    }

    #[test]
    fn parses_blocked_term_hold_without_automod_verdict() {
        let e = automod(
            "automod.message.hold",
            r#""reason": "blocked_term",
               "automod": null,
               "blocked_term": { "terms_found": [{ "term_id": "t1", "boundary": { "start_pos": 0, "end_pos": 2 }, "owner_broadcaster_user_id": "1971641", "owner_broadcaster_user_login": "streamer", "owner_broadcaster_user_name": "Streamer" }] },
               "held_at": "not a time""#,
        );
        let ChatEvent::AutomodHeld(h) = e else {
            panic!("expected a held message, got {e:?}");
        };
        assert_eq!(h.reason, "blocked_term");
        assert_eq!(h.category, "");
        assert_eq!(h.level, None);
        // An unreadable held_at falls back to the envelope timestamp.
        assert_eq!(h.held_at, 1_699_294_325_250);
    }

    #[test]
    fn parses_automod_update_v2_with_any_status_case() {
        for (status, want) in [
            ("approved", "approved"),
            ("Denied", "denied"),
            ("Expired", "expired"),
        ] {
            let e = automod(
                "automod.message.update",
                &format!(
                    r#""moderator_user_id": "7", "moderator_user_login": "modguy", "moderator_user_name": "ModGuy",
                       "reason": "automod", "automod": null, "blocked_term": null,
                       "status": "{status}", "held_at": "2023-11-06T18:12:04.000Z""#
                ),
            );
            assert_eq!(
                e,
                ChatEvent::AutomodResolved {
                    channel_id: "1971641".into(),
                    message_id: "held-1".into(),
                    status: want.into(),
                    moderator_login: "modguy".into(),
                    moderator_name: "ModGuy".into(),
                }
            );
        }
        let json = serde_json::to_value(automod(
            "automod.message.update",
            r#""status": "expired", "moderator_user_login": null, "moderator_user_name": null"#,
        ))
        .unwrap();
        assert_eq!(json["kind"], "automod_resolved");
        assert_eq!(json["moderator_login"], "");
    }

    fn broadcaster_feed(sub_type: &str, body: &str) -> ChatEvent {
        let raw = format!(
            r##"{{
                "metadata": {{ "message_type": "notification", "message_timestamp": "2020-07-15T17:16:04Z" }},
                "payload": {{
                    "subscription": {{ "type": "{sub_type}", "version": "1", "condition": {{ "broadcaster_user_id": "1337" }} }},
                    "event": {{
                        "id": "1243456",
                        "broadcaster_user_id": "1337",
                        "broadcaster_user_login": "cool_user",
                        "broadcaster_user_name": "Cool_User",
                        "title": "Aren't shoes just really hard socks?",
                        "started_at": "2020-07-15T17:16:03.17106713Z",
                        {body}
                    }}
                }}
            }}"##
        );
        event(raw.as_bytes())
    }

    #[test]
    fn poll_notifications_become_poll_updates() {
        for sub_type in [
            "channel.poll.begin",
            "channel.poll.progress",
            "channel.poll.end",
        ] {
            let e = broadcaster_feed(
                sub_type,
                r#""choices": [{ "id": "123", "title": "Yeah!", "bits_votes": 0, "channel_points_votes": 7, "votes": 12 }],
                   "bits_voting": { "is_enabled": false, "amount_per_vote": 0 },
                   "channel_points_voting": { "is_enabled": true, "amount_per_vote": 10 },
                   "status": "terminated",
                   "ends_at": "2020-07-15T17:16:08.17106713Z""#,
            );
            let ChatEvent::PollUpdate(p) = &e else {
                panic!("{sub_type}: expected a poll update, got {e:?}");
            };
            let ended = sub_type == "channel.poll.end";
            assert_eq!(p.status, if ended { "terminated" } else { "active" });
            assert_eq!(p.choices[0].votes, 12);
            let json = serde_json::to_value(&e).unwrap();
            assert_eq!(json["kind"], "poll_update");
            assert_eq!(json["channel_id"], "1337");
        }
    }

    #[test]
    fn prediction_notifications_become_prediction_updates() {
        for (sub_type, status) in [
            ("channel.prediction.begin", "active"),
            ("channel.prediction.progress", "active"),
            ("channel.prediction.lock", "locked"),
            ("channel.prediction.end", "canceled"),
        ] {
            let e = broadcaster_feed(
                sub_type,
                r#""outcomes": [{ "id": "1", "title": "Yeah!", "color": "blue", "users": 2, "channel_points": 300, "top_predictors": [] }],
                   "status": "canceled""#,
            );
            let ChatEvent::PredictionUpdate(p) = &e else {
                panic!("{sub_type}: expected a prediction update, got {e:?}");
            };
            assert_eq!(p.status, status, "{sub_type}");
            assert_eq!(p.outcomes[0].channel_points, 300);
            let json = serde_json::to_value(&e).unwrap();
            assert_eq!(json["kind"], "prediction_update");
            assert_eq!(json["outcomes"][0]["color"], "blue");
        }
    }

    #[test]
    fn ad_break_notification_becomes_an_ad_break() {
        let e = broadcaster_feed(
            "channel.ad_break.begin",
            r#""duration_seconds": 60, "is_automatic": true,
               "requester_user_id": "1337", "requester_user_login": "cool_user", "requester_user_name": "Cool_User""#,
        );
        let ChatEvent::AdBreak(ad) = &e else {
            panic!("expected an ad break, got {e:?}");
        };
        assert!(ad.is_automatic);
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "ad_break");
        assert_eq!(json["channel_id"], "1337");
        assert_eq!(json["duration_seconds"], 60);
        assert_eq!(json["started_at"], 1_594_833_363_171_i64);
        assert_eq!(json["requester_login"], "cool_user");
    }
}
