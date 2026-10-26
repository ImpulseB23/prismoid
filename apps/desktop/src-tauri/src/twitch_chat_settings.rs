//! Chat room modes for the active channel: emote-only, followers-only,
//! slow, subscribers-only, unique chat and the non-moderator delay. Read
//! with Helix `GET /chat/settings`, changed with `PATCH /chat/settings`;
//! both act as the signed-in user, who must moderate the channel.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::twitch_auth::{AuthState, TWITCH_CLIENT_ID};
use crate::twitch_channel::{helix_get, ChannelError, ChannelState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSettings {
    pub emote_mode: bool,
    pub follower_mode: bool,
    /// Minutes a follow must be old to chat; null when follower mode is off.
    pub follower_mode_duration: Option<u64>,
    pub slow_mode: bool,
    /// Seconds between messages; null when slow mode is off.
    pub slow_mode_wait_time: Option<u64>,
    pub subscriber_mode: bool,
    pub unique_chat_mode: bool,
    #[serde(default)]
    pub non_moderator_chat_delay: bool,
    /// 2, 4 or 6 seconds; null when the delay is off.
    #[serde(default)]
    pub non_moderator_chat_delay_duration: Option<u64>,
}

#[derive(Deserialize)]
struct ChatSettingsResponse {
    data: Vec<ChatSettings>,
}

/// Fields to change. Twitch applies only the fields present, so every one
/// is optional and the frontend sends just what the user touched. A
/// duration is only honoured together with its mode set to `true`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emote_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follower_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follower_mode_duration: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slow_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slow_mode_wait_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscriber_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique_chat_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub non_moderator_chat_delay: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub non_moderator_chat_delay_duration: Option<u64>,
}

/// Helix limits, from the Update Chat Settings reference.
pub const SLOW_MODE_RANGE: (u64, u64) = (3, 120);
pub const FOLLOWER_MODE_MAX_MINUTES: u64 = 129_600;
pub const NON_MOD_DELAY_CHOICES: [u64; 3] = [2, 4, 6];

/// Rejects values Helix would answer 400 to, so the user sees a clear
/// message instead of a raw API error.
pub fn validate_patch(p: &ChatSettingsPatch) -> Result<(), ChannelError> {
    if let Some(s) = p.slow_mode_wait_time {
        if s < SLOW_MODE_RANGE.0 || s > SLOW_MODE_RANGE.1 {
            return Err(ChannelError::InvalidSetting {
                message: format!(
                    "slow mode wait must be {} to {} seconds",
                    SLOW_MODE_RANGE.0, SLOW_MODE_RANGE.1
                ),
            });
        }
    }
    if let Some(m) = p.follower_mode_duration {
        if m > FOLLOWER_MODE_MAX_MINUTES {
            return Err(ChannelError::InvalidSetting {
                message: "followers-only duration must be at most 3 months".into(),
            });
        }
    }
    if let Some(d) = p.non_moderator_chat_delay_duration {
        if !NON_MOD_DELAY_CHOICES.contains(&d) {
            return Err(ChannelError::InvalidSetting {
                message: "non-moderator delay must be 2, 4 or 6 seconds".into(),
            });
        }
    }
    Ok(())
}

pub async fn fetch_chat_settings(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    moderator_id: &str,
) -> Result<ChatSettings, ChannelError> {
    let query = [
        ("broadcaster_id", broadcaster_id),
        ("moderator_id", moderator_id),
    ];
    let resp: ChatSettingsResponse = helix_get(
        http,
        format!("{helix_base}/chat/settings"),
        &query,
        access_token,
    )
    .await?;
    resp.data
        .into_iter()
        .next()
        .ok_or_else(|| ChannelError::Http {
            message: "empty chat settings response".into(),
        })
}

pub async fn update_chat_settings(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    moderator_id: &str,
    patch: &ChatSettingsPatch,
) -> Result<ChatSettings, ChannelError> {
    validate_patch(patch)?;
    let resp = http
        .patch(format!("{helix_base}/chat/settings"))
        .query(&[
            ("broadcaster_id", broadcaster_id),
            ("moderator_id", moderator_id),
        ])
        .header("Client-Id", TWITCH_CLIENT_ID)
        .bearer_auth(access_token)
        .json(patch)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let message = resp.text().await.unwrap_or_default();
        return Err(ChannelError::Helix {
            status: status.as_u16(),
            message,
        });
    }
    let body: ChatSettingsResponse = resp.json().await?;
    body.data
        .into_iter()
        .next()
        .ok_or_else(|| ChannelError::Http {
            message: "empty chat settings response".into(),
        })
}

#[tauri::command]
pub async fn twitch_get_chat_settings(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    channel_id: String,
) -> Result<Option<ChatSettings>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_chat_settings(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &channel_id,
        &tokens.user_id,
    )
    .await
    .map(Some)
}

#[tauri::command]
pub async fn twitch_update_chat_settings(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    channel_id: String,
    patch: ChatSettingsPatch,
) -> Result<ChatSettings, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    update_chat_settings(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &channel_id,
        &tokens.user_id,
        &patch,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    fn settings_json(slow: bool) -> serde_json::Value {
        serde_json::json!({
            "data": [{
                "broadcaster_id": "1",
                "moderator_id": "7",
                "emote_mode": false,
                "follower_mode": true,
                "follower_mode_duration": 10,
                "slow_mode": slow,
                "slow_mode_wait_time": if slow { serde_json::json!(30) } else { serde_json::Value::Null },
                "subscriber_mode": false,
                "unique_chat_mode": false,
                "non_moderator_chat_delay": false,
                "non_moderator_chat_delay_duration": null
            }]
        })
    }

    #[tokio::test]
    async fn fetch_reads_the_room_modes() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/chat/settings")
                .query_param("broadcaster_id", "1")
                .query_param("moderator_id", "7")
                .header("Authorization", "Bearer tok");
            then.status(200).json_body(settings_json(false));
        });
        let got = fetch_chat_settings(&reqwest::Client::new(), &server.base_url(), "tok", "1", "7")
            .await
            .unwrap();
        assert!(got.follower_mode);
        assert_eq!(got.follower_mode_duration, Some(10));
        assert!(!got.slow_mode);
        assert_eq!(got.slow_mode_wait_time, None);
    }

    #[tokio::test]
    async fn update_sends_only_touched_fields() {
        let server = MockServer::start_async().await;
        let patch_call = server.mock(|when, then| {
            when.method(PATCH)
                .path("/chat/settings")
                .query_param("broadcaster_id", "1")
                .query_param("moderator_id", "7")
                .header("Content-Type", "application/json")
                .json_body(serde_json::json!({ "slow_mode": true, "slow_mode_wait_time": 30 }));
            then.status(200).json_body(settings_json(true));
        });
        let patch = ChatSettingsPatch {
            slow_mode: Some(true),
            slow_mode_wait_time: Some(30),
            ..ChatSettingsPatch::default()
        };
        let got = update_chat_settings(
            &reqwest::Client::new(),
            &server.base_url(),
            "tok",
            "1",
            "7",
            &patch,
        )
        .await
        .unwrap();
        assert_eq!(patch_call.calls(), 1);
        assert!(got.slow_mode);
        assert_eq!(got.slow_mode_wait_time, Some(30));
    }

    #[tokio::test]
    async fn update_rejects_out_of_range_values_before_calling_helix() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(PATCH).path("/chat/settings");
            then.status(200).json_body(settings_json(true));
        });
        let bad = ChatSettingsPatch {
            slow_mode: Some(true),
            slow_mode_wait_time: Some(1),
            ..ChatSettingsPatch::default()
        };
        let err = update_chat_settings(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "1",
            "7",
            &bad,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        assert_eq!(any.calls(), 0);

        let delay = ChatSettingsPatch {
            non_moderator_chat_delay: Some(true),
            non_moderator_chat_delay_duration: Some(5),
            ..ChatSettingsPatch::default()
        };
        assert!(validate_patch(&delay).is_err());
        let ok = ChatSettingsPatch {
            non_moderator_chat_delay_duration: Some(4),
            follower_mode_duration: Some(129_600),
            ..ChatSettingsPatch::default()
        };
        assert!(validate_patch(&ok).is_ok());
    }

    #[tokio::test]
    async fn update_surfaces_helix_errors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PATCH).path("/chat/settings");
            then.status(403).body("not a moderator");
        });
        let patch = ChatSettingsPatch {
            emote_mode: Some(true),
            ..ChatSettingsPatch::default()
        };
        let err = update_chat_settings(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "1",
            "7",
            &patch,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 403, .. }));
    }
}
