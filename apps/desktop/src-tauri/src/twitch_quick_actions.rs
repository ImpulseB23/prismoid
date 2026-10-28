//! Stream manager quick actions on the signed-in broadcaster's own channel:
//! stream markers (`channel:manage:broadcast`), clips (`clips:edit`),
//! shoutouts (`moderator:manage:shoutouts`), announcements
//! (`moderator:manage:announcements`), Shield Mode
//! (`moderator:manage:shield_mode`) and the mod-pinned chat message
//! (`moderator:manage:chat_messages`). The user is both broadcaster and
//! moderator here, so every `moderator_id` is their own id.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::message::{null_default, parse_platform_ts};
use crate::twitch_auth::AuthState;
use crate::twitch_channel::{
    check_text, helix_get, helix_send, helix_write, ChannelError, ChannelState,
};
use crate::twitch_polls::optional_ts;

/// Limits from the Create Stream Marker, Create Clip, Send Chat
/// Announcement and Pin Chat Message references.
pub const MARKER_DESCRIPTION_MAX_CHARS: usize = 140;
pub const CLIP_DURATION_SECS: (f64, f64) = (5.0, 60.0);
pub const ANNOUNCEMENT_MAX_CHARS: usize = 500;
pub const PIN_DURATION_SECS: (u64, u64) = (30, 1800);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Marker {
    pub id: String,
    pub created_at: i64,
    /// Offset from the start of the stream.
    pub position_seconds: u64,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedClip {
    pub id: String,
    /// Where the broadcaster trims, titles and publishes the clip; valid
    /// for 24 hours or until published.
    pub edit_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Clip {
    pub id: String,
    pub url: String,
    pub title: String,
    pub duration: f64,
    pub thumbnail_url: String,
    pub view_count: u64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnouncementColor {
    /// The channel's accent color.
    Primary,
    Blue,
    Green,
    Orange,
    Purple,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShieldMode {
    pub is_active: bool,
    /// Who last turned it on; empty if it never was.
    pub moderator_id: String,
    pub moderator_login: String,
    pub moderator_name: String,
    pub last_activated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PinnedMessage {
    pub message_id: String,
    pub sender_user_id: String,
    pub sender_user_login: String,
    pub sender_user_name: String,
    pub pinned_by_user_id: String,
    pub pinned_by_user_login: String,
    pub pinned_by_user_name: String,
    pub text: String,
    pub starts_at: i64,
    /// `None` when pinned until the stream ends.
    pub ends_at: Option<i64>,
    pub updated_at: i64,
}

fn invalid(message: &str) -> ChannelError {
    ChannelError::InvalidSetting {
        message: message.into(),
    }
}

fn single<T>(data: Vec<T>, what: &str) -> Result<T, ChannelError> {
    data.into_iter().next().ok_or_else(|| ChannelError::Http {
        message: format!("empty {what} response"),
    })
}

/// Swaps a Helix error with `status` for a kind the UI can explain.
fn remap(err: ChannelError, status: u16, to: fn(String) -> ChannelError) -> ChannelError {
    match err {
        ChannelError::Helix { status: s, message } if s == status => to(message),
        other => other,
    }
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.trim().is_empty())
}

// --- Markers ---

// The reference types the id as a string but its example sends a number.
#[derive(Deserialize)]
#[serde(untagged)]
enum MarkerId {
    Text(String),
    Number(u64),
}

#[derive(Deserialize)]
struct HelixMarker {
    id: MarkerId,
    created_at: String,
    #[serde(default)]
    position_seconds: u64,
    #[serde(default, deserialize_with = "null_default")]
    description: String,
}

#[derive(Deserialize)]
struct MarkersResponse {
    data: Vec<HelixMarker>,
}

#[derive(Serialize)]
struct MarkerBody<'a> {
    user_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
}

pub async fn create_marker(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    description: Option<&str>,
) -> Result<Marker, ChannelError> {
    let description = non_blank(description);
    if let Some(d) = description {
        check_text("marker description", d, MARKER_DESCRIPTION_MAX_CHARS)?;
    }
    let body = MarkerBody {
        user_id: broadcaster_id,
        description,
    };
    let resp: MarkersResponse = helix_write(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/streams/markers"),
        &[],
        access_token,
        &body,
    )
    .await
    .map_err(|e| {
        remap(e, 404, |message| ChannelError::MarkerUnavailable {
            message,
        })
    })?
    .json()
    .await?;
    let m = single(resp.data, "marker")?;
    Ok(Marker {
        id: match m.id {
            MarkerId::Text(s) => s,
            MarkerId::Number(n) => n.to_string(),
        },
        created_at: parse_platform_ts(&m.created_at)?,
        position_seconds: m.position_seconds,
        description: m.description,
    })
}

// --- Clips ---

#[derive(Deserialize)]
struct CreatedClipsResponse {
    data: Vec<CreatedClip>,
}

#[derive(Deserialize)]
struct HelixClip {
    id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    view_count: u64,
    created_at: String,
}

#[derive(Deserialize)]
struct ClipsResponse {
    data: Vec<HelixClip>,
}

/// Starts a clip of the last moments of the live stream. Twitch finishes
/// it in the background; [`fetch_clip`] tells when it is done. `duration`
/// defaults to 30 seconds and is sent at Twitch's 0.1 s precision.
pub async fn create_clip(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    title: Option<&str>,
    duration: Option<f64>,
) -> Result<CreatedClip, ChannelError> {
    let (min, max) = CLIP_DURATION_SECS;
    if duration.is_some_and(|d| !(min..=max).contains(&d)) {
        return Err(invalid("clip length must be 5 to 60 seconds"));
    }
    let duration = duration.map(|d| format!("{d:.1}"));
    let mut query = vec![("broadcaster_id", broadcaster_id)];
    if let Some(t) = non_blank(title) {
        query.push(("title", t));
    }
    if let Some(d) = &duration {
        query.push(("duration", d));
    }
    let resp: CreatedClipsResponse = helix_send(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/clips"),
        &query,
        access_token,
    )
    .await
    .map_err(|e| remap(e, 404, |message| ChannelError::NotLive { message }))?
    .json()
    .await?;
    single(resp.data, "clip")
}

/// The clip once Twitch finished it. Still `None` about 60 seconds after
/// [`create_clip`] means it failed.
pub async fn fetch_clip(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    clip_id: &str,
) -> Result<Option<Clip>, ChannelError> {
    let resp: ClipsResponse = helix_get(
        http,
        format!("{helix_base}/clips"),
        &[("id", clip_id)],
        access_token,
    )
    .await?;
    let Some(c) = resp.data.into_iter().next() else {
        return Ok(None);
    };
    Ok(Some(Clip {
        created_at: parse_platform_ts(&c.created_at)?,
        id: c.id,
        url: c.url,
        title: c.title,
        duration: c.duration,
        thumbnail_url: c.thumbnail_url,
        view_count: c.view_count,
    }))
}

// --- Chat ---

pub async fn send_shoutout(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    to_broadcaster_id: &str,
) -> Result<(), ChannelError> {
    if to_broadcaster_id.trim().is_empty() {
        return Err(invalid("pick a channel to shout out"));
    }
    if to_broadcaster_id == broadcaster_id {
        return Err(invalid("you cannot shout out your own channel"));
    }
    helix_send(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/chat/shoutouts"),
        &[
            ("from_broadcaster_id", broadcaster_id),
            ("to_broadcaster_id", to_broadcaster_id),
            ("moderator_id", broadcaster_id),
        ],
        access_token,
    )
    .await
    // With the ids checked above, the 400 left is "not live or no viewers".
    .map_err(|e| {
        remap(e, 400, |message| ChannelError::ShoutoutNeedsViewers {
            message,
        })
    })
    .map_err(|e| remap(e, 429, |message| ChannelError::ShoutoutCooldown { message }))?;
    Ok(())
}

#[derive(Serialize)]
struct AnnouncementBody<'a> {
    message: &'a str,
    color: AnnouncementColor,
}

/// Twitch truncates past the limit, so longer text is refused instead.
pub async fn send_announcement(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    message: &str,
    color: AnnouncementColor,
) -> Result<(), ChannelError> {
    check_text("announcement", message, ANNOUNCEMENT_MAX_CHARS)?;
    helix_write(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/chat/announcements"),
        &[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", broadcaster_id),
        ],
        access_token,
        &AnnouncementBody { message, color },
    )
    .await?;
    Ok(())
}

// --- Shield Mode ---

#[derive(Deserialize)]
struct HelixShieldMode {
    is_active: bool,
    #[serde(default, deserialize_with = "null_default")]
    moderator_id: String,
    #[serde(default, deserialize_with = "null_default")]
    moderator_login: String,
    #[serde(default, deserialize_with = "null_default")]
    moderator_name: String,
    #[serde(default)]
    last_activated_at: Option<String>,
}

#[derive(Deserialize)]
struct ShieldModeResponse {
    data: Vec<HelixShieldMode>,
}

fn shield_mode(resp: ShieldModeResponse) -> Result<ShieldMode, ChannelError> {
    let s = single(resp.data, "shield mode")?;
    Ok(ShieldMode {
        is_active: s.is_active,
        moderator_id: s.moderator_id,
        moderator_login: s.moderator_login,
        moderator_name: s.moderator_name,
        last_activated_at: optional_ts(s.last_activated_at)?,
    })
}

pub async fn fetch_shield_mode(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<ShieldMode, ChannelError> {
    let resp = helix_get(
        http,
        format!("{helix_base}/moderation/shield_mode"),
        &[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", broadcaster_id),
        ],
        access_token,
    )
    .await?;
    shield_mode(resp)
}

#[derive(Serialize)]
struct ShieldModeBody {
    is_active: bool,
}

pub async fn set_shield_mode(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    is_active: bool,
) -> Result<ShieldMode, ChannelError> {
    let resp = helix_write(
        http,
        reqwest::Method::PUT,
        format!("{helix_base}/moderation/shield_mode"),
        &[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", broadcaster_id),
        ],
        access_token,
        &ShieldModeBody { is_active },
    )
    .await?
    .json()
    .await?;
    shield_mode(resp)
}

// --- Pinned message ---

#[derive(Deserialize)]
struct PinnedText {
    #[serde(default, deserialize_with = "null_default")]
    text: String,
}

#[derive(Deserialize)]
struct HelixPin {
    message_id: String,
    #[serde(default, deserialize_with = "null_default")]
    sender_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    sender_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    sender_user_name: String,
    #[serde(default, deserialize_with = "null_default")]
    pinned_by_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    pinned_by_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    pinned_by_user_name: String,
    message: Option<PinnedText>,
    starts_at: String,
    #[serde(default)]
    ends_at: Option<String>,
    updated_at: String,
}

#[derive(Deserialize)]
struct PinsResponse {
    data: Vec<HelixPin>,
}

/// The mod-pinned message, or `None` when nothing is pinned. Twitch allows
/// one per channel.
pub async fn fetch_pinned_message(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<Option<PinnedMessage>, ChannelError> {
    let resp: PinsResponse = helix_get(
        http,
        format!("{helix_base}/chat/pins"),
        &[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", broadcaster_id),
        ],
        access_token,
    )
    .await?;
    let Some(p) = resp.data.into_iter().next() else {
        return Ok(None);
    };
    Ok(Some(PinnedMessage {
        starts_at: parse_platform_ts(&p.starts_at)?,
        ends_at: optional_ts(p.ends_at)?,
        updated_at: parse_platform_ts(&p.updated_at)?,
        message_id: p.message_id,
        sender_user_id: p.sender_user_id,
        sender_user_login: p.sender_user_login,
        sender_user_name: p.sender_user_name,
        pinned_by_user_id: p.pinned_by_user_id,
        pinned_by_user_login: p.pinned_by_user_login,
        pinned_by_user_name: p.pinned_by_user_name,
        text: p.message.map(|m| m.text).unwrap_or_default(),
    }))
}

/// Pins a chat message, replacing any current pin. Without
/// `duration_seconds` it stays until the stream ends.
pub async fn pin_message(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    message_id: &str,
    duration_seconds: Option<u64>,
) -> Result<(), ChannelError> {
    if message_id.is_empty() {
        return Err(invalid("pick a message to pin"));
    }
    let (min, max) = PIN_DURATION_SECS;
    if duration_seconds.is_some_and(|d| !(min..=max).contains(&d)) {
        return Err(invalid("pin length must be 30 to 1800 seconds"));
    }
    let duration = duration_seconds.map(|d| d.to_string());
    let mut query = vec![
        ("broadcaster_id", broadcaster_id),
        ("moderator_id", broadcaster_id),
        ("message_id", message_id),
    ];
    if let Some(d) = &duration {
        query.push(("duration_seconds", d));
    }
    helix_send(
        http,
        reqwest::Method::PUT,
        format!("{helix_base}/chat/pins"),
        &query,
        access_token,
    )
    .await
    .map_err(|e| remap(e, 409, |message| ChannelError::AlreadyPinned { message }))?;
    Ok(())
}

pub async fn unpin_message(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    message_id: &str,
) -> Result<(), ChannelError> {
    helix_send(
        http,
        reqwest::Method::DELETE,
        format!("{helix_base}/chat/pins"),
        &[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", broadcaster_id),
            ("message_id", message_id),
        ],
        access_token,
    )
    .await?;
    Ok(())
}

// --- Commands ---

#[tauri::command]
pub async fn twitch_create_marker(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    description: Option<String>,
) -> Result<Marker, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    create_marker(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        description.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn twitch_create_clip(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    title: Option<String>,
    duration: Option<f64>,
) -> Result<CreatedClip, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    create_clip(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        title.as_deref(),
        duration,
    )
    .await
}

#[tauri::command]
pub async fn twitch_get_clip(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    clip_id: String,
) -> Result<Option<Clip>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_clip(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &clip_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_send_shoutout(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    to_broadcaster_id: String,
) -> Result<(), ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    send_shoutout(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &to_broadcaster_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_send_announcement(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    message: String,
    color: AnnouncementColor,
) -> Result<(), ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    send_announcement(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &message,
        color,
    )
    .await
}

#[tauri::command]
pub async fn twitch_get_shield_mode(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<ShieldMode, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_shield_mode(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_set_shield_mode(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    is_active: bool,
) -> Result<ShieldMode, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    set_shield_mode(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        is_active,
    )
    .await
}

#[tauri::command]
pub async fn twitch_get_pinned_message(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<Option<PinnedMessage>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_pinned_message(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_pin_message(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    message_id: String,
    duration_seconds: Option<u64>,
) -> Result<(), ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    pin_message(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &message_id,
        duration_seconds,
    )
    .await
}

#[tauri::command]
pub async fn twitch_unpin_message(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    message_id: String,
) -> Result<(), ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    unpin_message(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &message_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    const AT: &str = "2018-08-20T20:10:03Z";
    const AT_MS: i64 = 1_534_795_803_000;

    fn http() -> reqwest::Client {
        reqwest::Client::new()
    }

    #[tokio::test]
    async fn marker_posts_description_and_reads_numeric_id() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/streams/markers")
                .header("Authorization", "Bearer t")
                .json_body(serde_json::json!({ "user_id": "7", "description": "hello" }));
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "id": 123,
                    "created_at": AT,
                    "description": "hello",
                    "position_seconds": 244
                }]
            }));
        });
        let m = create_marker(&http(), &server.base_url(), "t", "7", Some("hello"))
            .await
            .unwrap();
        assert_eq!(call.calls(), 1);
        assert_eq!(
            m,
            Marker {
                id: "123".into(),
                created_at: AT_MS,
                position_seconds: 244,
                description: "hello".into(),
            }
        );
    }

    #[tokio::test]
    async fn marker_without_description_omits_it() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/streams/markers")
                .json_body(serde_json::json!({ "user_id": "7" }));
            then.status(200).json_body(serde_json::json!({
                "data": [{ "id": "m1", "created_at": AT, "description": "", "position_seconds": 0 }]
            }));
        });
        let base = server.base_url();
        let m = create_marker(&http(), &base, "t", "7", None).await.unwrap();
        assert_eq!(m.id, "m1");
        create_marker(&http(), &base, "t", "7", Some("  "))
            .await
            .unwrap();
        assert_eq!(call.calls(), 2);
    }

    #[tokio::test]
    async fn marker_checks_length_before_calling() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(POST).path("/streams/markers");
            then.status(500);
        });
        let long = "x".repeat(MARKER_DESCRIPTION_MAX_CHARS + 1);
        let err = create_marker(&http(), &server.base_url(), "t", "7", Some(&long))
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        assert_eq!(any.calls(), 0);
    }

    #[tokio::test]
    async fn marker_404_is_unavailable() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/streams/markers");
            then.status(404).body("not streaming live");
        });
        let err = create_marker(&http(), &server.base_url(), "t", "7", None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ChannelError::MarkerUnavailable { message } if message == "not streaming live")
        );
    }

    #[tokio::test]
    async fn marker_other_errors_pass_through() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/streams/markers");
            then.status(401).body("missing scope");
        });
        let err = create_marker(&http(), &server.base_url(), "t", "7", None)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
    }

    #[tokio::test]
    async fn clip_sends_title_and_duration_as_query() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/clips")
                .query_param("broadcaster_id", "7")
                .query_param("title", "nice")
                .query_param("duration", "12.5");
            then.status(202).json_body(serde_json::json!({
                "data": [{
                    "id": "FiveWordsForClipSlug",
                    "edit_url": "https://www.twitch.tv/me/clip/FiveWordsForClipSlug"
                }]
            }));
        });
        let clip = create_clip(
            &http(),
            &server.base_url(),
            "t",
            "7",
            Some("nice"),
            Some(12.5),
        )
        .await
        .unwrap();
        assert_eq!(call.calls(), 1);
        assert_eq!(
            clip,
            CreatedClip {
                id: "FiveWordsForClipSlug".into(),
                edit_url: "https://www.twitch.tv/me/clip/FiveWordsForClipSlug".into(),
            }
        );
    }

    #[tokio::test]
    async fn clip_defaults_leave_title_and_duration_off() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/clips")
                .query_param("broadcaster_id", "7")
                .query_param_missing("title")
                .query_param_missing("duration");
            then.status(202).json_body(serde_json::json!({
                "data": [{ "id": "c", "edit_url": "u" }]
            }));
        });
        create_clip(&http(), &server.base_url(), "t", "7", Some(" "), None)
            .await
            .unwrap();
        assert_eq!(call.calls(), 1);
    }

    #[tokio::test]
    async fn clip_duration_range_matches_the_reference() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(POST).path("/clips");
            then.status(202)
                .json_body(serde_json::json!({ "data": [{ "id": "c", "edit_url": "u" }] }));
        });
        let base = server.base_url();
        for bad in [4.9, 60.1, f64::NAN] {
            let err = create_clip(&http(), &base, "t", "7", None, Some(bad))
                .await
                .unwrap_err();
            assert!(matches!(err, ChannelError::InvalidSetting { .. }), "{bad}");
        }
        assert_eq!(any.calls(), 0);
        for ok in [5.0, 60.0] {
            create_clip(&http(), &base, "t", "7", None, Some(ok))
                .await
                .unwrap();
        }
        assert_eq!(any.calls(), 2);
    }

    #[tokio::test]
    async fn clip_offline_is_not_live() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/clips");
            then.status(404).body("must be broadcasting live");
        });
        let err = create_clip(&http(), &server.base_url(), "t", "7", None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::NotLive { .. }));
    }

    #[tokio::test]
    async fn clip_empty_response_is_an_error() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/clips");
            then.status(202)
                .json_body(serde_json::json!({ "data": [] }));
        });
        let err = create_clip(&http(), &server.base_url(), "t", "7", None, None)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Http { .. }));
    }

    #[tokio::test]
    async fn fetch_clip_reads_a_finished_clip() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/clips").query_param("id", "Slug");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "id": "Slug",
                    "url": "https://clips.twitch.tv/Slug",
                    "embed_url": "https://clips.twitch.tv/embed?clip=Slug",
                    "broadcaster_id": "7",
                    "broadcaster_name": "Me",
                    "creator_id": "7",
                    "creator_name": "Me",
                    "video_id": "",
                    "game_id": "488191",
                    "language": "en",
                    "title": "babymetal",
                    "view_count": 10,
                    "created_at": AT,
                    "thumbnail_url": "https://clips-media-assets.twitch.tv/p.jpg",
                    "duration": 12.9,
                    "vod_offset": null,
                    "is_featured": false
                }]
            }));
        });
        let clip = fetch_clip(&http(), &server.base_url(), "t", "Slug")
            .await
            .unwrap();
        assert_eq!(
            clip,
            Some(Clip {
                id: "Slug".into(),
                url: "https://clips.twitch.tv/Slug".into(),
                title: "babymetal".into(),
                duration: 12.9,
                thumbnail_url: "https://clips-media-assets.twitch.tv/p.jpg".into(),
                view_count: 10,
                created_at: AT_MS,
            })
        );
    }

    #[tokio::test]
    async fn fetch_clip_is_none_while_processing() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/clips");
            then.status(200)
                .json_body(serde_json::json!({ "data": [], "pagination": {} }));
        });
        let clip = fetch_clip(&http(), &server.base_url(), "t", "Slug")
            .await
            .unwrap();
        assert_eq!(clip, None);
    }

    #[tokio::test]
    async fn shoutout_sends_both_ids_as_moderator() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/chat/shoutouts")
                .query_param("from_broadcaster_id", "7")
                .query_param("to_broadcaster_id", "9")
                .query_param("moderator_id", "7");
            then.status(204);
        });
        send_shoutout(&http(), &server.base_url(), "t", "7", "9")
            .await
            .unwrap();
        assert_eq!(call.calls(), 1);
    }

    #[tokio::test]
    async fn shoutout_rejects_self_and_blank_before_calling() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(POST).path("/chat/shoutouts");
            then.status(204);
        });
        for to in ["7", " "] {
            let err = send_shoutout(&http(), &server.base_url(), "t", "7", to)
                .await
                .unwrap_err();
            assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        }
        assert_eq!(any.calls(), 0);
    }

    #[tokio::test]
    async fn shoutout_maps_cooldown_and_viewer_errors() {
        for (status, to) in [(429, "9"), (400, "10"), (403, "11")] {
            let server = MockServer::start_async().await;
            server.mock(|when, then| {
                when.method(POST).path("/chat/shoutouts");
                then.status(status).body("nope");
            });
            let err = send_shoutout(&http(), &server.base_url(), "t", "7", to)
                .await
                .unwrap_err();
            match status {
                429 => assert!(matches!(err, ChannelError::ShoutoutCooldown { .. })),
                400 => assert!(matches!(err, ChannelError::ShoutoutNeedsViewers { .. })),
                _ => assert!(matches!(err, ChannelError::Helix { status: 403, .. })),
            }
        }
    }

    #[tokio::test]
    async fn announcement_posts_message_and_color() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/chat/announcements")
                .query_param("broadcaster_id", "7")
                .query_param("moderator_id", "7")
                .json_body(serde_json::json!({ "message": "Hello chat!", "color": "primary" }));
            then.status(204);
        });
        send_announcement(
            &http(),
            &server.base_url(),
            "t",
            "7",
            "Hello chat!",
            AnnouncementColor::Primary,
        )
        .await
        .unwrap();
        assert_eq!(call.calls(), 1);
    }

    #[test]
    fn announcement_colors_use_the_case_sensitive_names() {
        let names: Vec<_> = [
            AnnouncementColor::Primary,
            AnnouncementColor::Blue,
            AnnouncementColor::Green,
            AnnouncementColor::Orange,
            AnnouncementColor::Purple,
        ]
        .iter()
        .map(|c| serde_json::to_value(c).unwrap())
        .collect();
        assert_eq!(
            names,
            ["primary", "blue", "green", "orange", "purple"].map(serde_json::Value::from)
        );
        assert!(serde_json::from_str::<AnnouncementColor>("\"red\"").is_err());
    }

    #[tokio::test]
    async fn announcement_checks_text_before_calling() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(POST).path("/chat/announcements");
            then.status(204);
        });
        let base = server.base_url();
        for msg in [" ".to_owned(), "x".repeat(ANNOUNCEMENT_MAX_CHARS + 1)] {
            let err = send_announcement(&http(), &base, "t", "7", &msg, AnnouncementColor::Blue)
                .await
                .unwrap_err();
            assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        }
        assert_eq!(any.calls(), 0);
        let full = "x".repeat(ANNOUNCEMENT_MAX_CHARS);
        send_announcement(&http(), &base, "t", "7", &full, AnnouncementColor::Blue)
            .await
            .unwrap();
        assert_eq!(any.calls(), 1);
    }

    #[tokio::test]
    async fn announcement_surfaces_helix_errors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/chat/announcements");
            then.status(429).body("slow down");
        });
        let err = send_announcement(
            &http(),
            &server.base_url(),
            "t",
            "7",
            "hi",
            AnnouncementColor::Green,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 429, .. }));
    }

    #[tokio::test]
    async fn shield_mode_reads_a_never_activated_channel() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/moderation/shield_mode")
                .query_param("broadcaster_id", "7")
                .query_param("moderator_id", "7");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "is_active": false,
                    "moderator_id": "",
                    "moderator_name": "",
                    "moderator_login": "",
                    "last_activated_at": ""
                }]
            }));
        });
        let s = fetch_shield_mode(&http(), &server.base_url(), "t", "7")
            .await
            .unwrap();
        assert_eq!(
            s,
            ShieldMode {
                is_active: false,
                moderator_id: String::new(),
                moderator_login: String::new(),
                moderator_name: String::new(),
                last_activated_at: None,
            }
        );
    }

    #[tokio::test]
    async fn shield_mode_puts_the_new_state() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(PUT)
                .path("/moderation/shield_mode")
                .query_param("broadcaster_id", "7")
                .query_param("moderator_id", "7")
                .json_body(serde_json::json!({ "is_active": true }));
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "is_active": true,
                    "moderator_id": "7",
                    "moderator_name": "Me",
                    "moderator_login": "me",
                    "last_activated_at": AT
                }]
            }));
        });
        let s = set_shield_mode(&http(), &server.base_url(), "t", "7", true)
            .await
            .unwrap();
        assert_eq!(call.calls(), 1);
        assert!(s.is_active);
        assert_eq!(s.moderator_login, "me");
        assert_eq!(s.last_activated_at, Some(AT_MS));
    }

    #[tokio::test]
    async fn shield_mode_errors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PUT).path("/moderation/shield_mode");
            then.status(401)
                .body("missing moderator:manage:shield_mode");
        });
        server.mock(|when, then| {
            when.method(GET).path("/moderation/shield_mode");
            then.status(200)
                .json_body(serde_json::json!({ "data": [] }));
        });
        let base = server.base_url();
        let err = set_shield_mode(&http(), &base, "t", "7", false)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
        let err = fetch_shield_mode(&http(), &base, "t", "7")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Http { .. }));
    }

    #[tokio::test]
    async fn pinned_message_reads_the_current_pin() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/chat/pins")
                .query_param("broadcaster_id", "7")
                .query_param("moderator_id", "7");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "message_id": "abc-def-123-456",
                    "broadcaster_id": "7",
                    "sender_user_id": "12826",
                    "sender_user_login": "twitch",
                    "sender_user_name": "Twitch",
                    "pinned_by_user_id": "7",
                    "pinned_by_user_login": "me",
                    "pinned_by_user_name": "Me",
                    "message": {
                        "text": "Welcome! bleedPurple Type !rules",
                        "fragments": [
                            { "type": "text", "text": "Welcome! ", "cheermote": null, "emote": null, "mention": null },
                            {
                                "type": "emote", "text": "bleedPurple", "cheermote": null,
                                "emote": { "id": "62835", "emote_set_id": "0", "owner_id": "0", "format": ["static"] },
                                "mention": null
                            }
                        ]
                    },
                    "starts_at": AT,
                    "ends_at": "2018-08-20T20:15:03Z",
                    "updated_at": AT
                }]
            }));
        });
        let pin = fetch_pinned_message(&http(), &server.base_url(), "t", "7")
            .await
            .unwrap();
        assert_eq!(
            pin,
            Some(PinnedMessage {
                message_id: "abc-def-123-456".into(),
                sender_user_id: "12826".into(),
                sender_user_login: "twitch".into(),
                sender_user_name: "Twitch".into(),
                pinned_by_user_id: "7".into(),
                pinned_by_user_login: "me".into(),
                pinned_by_user_name: "Me".into(),
                text: "Welcome! bleedPurple Type !rules".into(),
                starts_at: AT_MS,
                ends_at: Some(AT_MS + 300_000),
                updated_at: AT_MS,
            })
        );
    }

    #[tokio::test]
    async fn pinned_message_until_stream_end_and_none() {
        let server = MockServer::start_async().await;
        let mut pinned = server.mock(|when, then| {
            when.method(GET).path("/chat/pins");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "message_id": "m",
                    "message": { "text": "hi", "fragments": [] },
                    "starts_at": AT,
                    "ends_at": null,
                    "updated_at": AT
                }]
            }));
        });
        let base = server.base_url();
        let pin = fetch_pinned_message(&http(), &base, "t", "7")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pin.ends_at, None);
        assert_eq!(pin.text, "hi");
        pinned.delete();
        server.mock(|when, then| {
            when.method(GET).path("/chat/pins");
            then.status(200)
                .json_body(serde_json::json!({ "data": [] }));
        });
        assert_eq!(
            fetch_pinned_message(&http(), &base, "t", "7")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn pin_sends_message_and_duration() {
        let server = MockServer::start_async().await;
        let timed = server.mock(|when, then| {
            when.method(PUT)
                .path("/chat/pins")
                .query_param("broadcaster_id", "7")
                .query_param("moderator_id", "7")
                .query_param("message_id", "m")
                .query_param("duration_seconds", "300");
            then.status(204);
        });
        let open = server.mock(|when, then| {
            when.method(PUT)
                .path("/chat/pins")
                .query_param("message_id", "n")
                .query_param_missing("duration_seconds");
            then.status(204);
        });
        let base = server.base_url();
        pin_message(&http(), &base, "t", "7", "m", Some(300))
            .await
            .unwrap();
        pin_message(&http(), &base, "t", "7", "n", None)
            .await
            .unwrap();
        assert_eq!((timed.calls(), open.calls()), (1, 1));
    }

    #[tokio::test]
    async fn pin_checks_before_calling() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(PUT).path("/chat/pins");
            then.status(204);
        });
        let base = server.base_url();
        for (id, secs) in [("", None), ("m", Some(29)), ("m", Some(1801))] {
            let err = pin_message(&http(), &base, "t", "7", id, secs)
                .await
                .unwrap_err();
            assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        }
        assert_eq!(any.calls(), 0);
        for secs in [30, 1800] {
            pin_message(&http(), &base, "t", "7", "m", Some(secs))
                .await
                .unwrap();
        }
        assert_eq!(any.calls(), 2);
    }

    #[tokio::test]
    async fn pin_conflict_is_already_pinned() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PUT)
                .path("/chat/pins")
                .query_param("message_id", "m");
            then.status(409).body("already pinned");
        });
        server.mock(|when, then| {
            when.method(PUT)
                .path("/chat/pins")
                .query_param("message_id", "gone");
            then.status(404).body("not found");
        });
        let base = server.base_url();
        let err = pin_message(&http(), &base, "t", "7", "m", None)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::AlreadyPinned { .. }));
        let err = pin_message(&http(), &base, "t", "7", "gone", None)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 404, .. }));
    }

    #[tokio::test]
    async fn unpin_deletes_by_message_id() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(DELETE)
                .path("/chat/pins")
                .query_param("broadcaster_id", "7")
                .query_param("moderator_id", "7")
                .query_param("message_id", "m");
            then.status(204);
        });
        server.mock(|when, then| {
            when.method(DELETE)
                .path("/chat/pins")
                .query_param("message_id", "gone");
            then.status(404);
        });
        let base = server.base_url();
        unpin_message(&http(), &base, "t", "7", "m").await.unwrap();
        assert_eq!(call.calls(), 1);
        let err = unpin_message(&http(), &base, "t", "7", "gone")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 404, .. }));
    }
}
