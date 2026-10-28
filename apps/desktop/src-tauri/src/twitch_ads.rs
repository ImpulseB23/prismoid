//! Ads on the signed-in broadcaster's own channel: the schedule from Helix
//! `GET /channels/ads` (scope `channel:read:ads`), snoozing the next one
//! with `POST /channels/ads/schedule/snooze` (`channel:manage:ads`) and
//! running one with `POST /channels/commercial` (`channel:edit:commercial`).
//! The `channel.ad_break.begin` v1 notification reports every ad break as
//! it starts. Timestamps are Unix milliseconds.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::message::{null_default, parse_platform_ts, ParseError};
use crate::twitch_auth::{AuthState, TWITCH_CLIENT_ID};
use crate::twitch_channel::{helix_get, helix_write, ChannelError, ChannelState};

/// Longest commercial Start Commercial accepts, in seconds.
pub const COMMERCIAL_MAX_SECS: u64 = 180;

/// Get Ad Schedule: "a new ad cannot be run until 8 minutes after running
/// a previous ad".
const AD_COOLDOWN_MS: i64 = 8 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdSchedule {
    /// Next scheduled ad; `None` when nothing is scheduled or the channel
    /// is offline.
    #[serde(default, deserialize_with = "ad_time")]
    pub next_ad_at: Option<i64>,
    /// `None` when no ad ran this stream or the channel is offline.
    #[serde(default, deserialize_with = "ad_time")]
    pub last_ad_at: Option<i64>,
    /// Seconds the upcoming ad break lasts.
    #[serde(default, deserialize_with = "loose_u64")]
    pub duration: u64,
    /// Seconds of pre-roll free time left; 0 when there is none.
    #[serde(default, deserialize_with = "loose_u64")]
    pub preroll_free_time: u64,
    #[serde(default, deserialize_with = "loose_u64")]
    pub snooze_count: u64,
    /// When the next snooze is gained.
    #[serde(default, deserialize_with = "ad_time")]
    pub snooze_refresh_at: Option<i64>,
}

/// What Snooze Next Ad changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdSnooze {
    #[serde(default, deserialize_with = "ad_time")]
    pub next_ad_at: Option<i64>,
    #[serde(default, deserialize_with = "loose_u64")]
    pub snooze_count: u64,
    #[serde(default, deserialize_with = "ad_time")]
    pub snooze_refresh_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commercial {
    /// Seconds requested, capped at 180; Twitch may serve more or less.
    #[serde(default, deserialize_with = "loose_u64")]
    pub length: u64,
    /// Whether Twitch could serve an ad; often empty.
    #[serde(default, deserialize_with = "null_default")]
    pub message: String,
    /// Seconds until another commercial may run.
    #[serde(default, deserialize_with = "loose_u64")]
    pub retry_after: u64,
}

/// An ad break began on the user's own channel, from
/// `channel.ad_break.begin` v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AdBreak {
    pub channel_id: String,
    pub duration_seconds: u64,
    pub started_at: i64,
    /// Scheduled by Ads Manager rather than run by hand.
    pub is_automatic: bool,
    /// The broadcaster for automatic ads.
    pub requester_id: String,
    pub requester_login: String,
    pub requester_name: String,
}

// The reference types the counts as integers and the flag as a boolean,
// but its examples quote them, so both forms parse.
#[derive(Deserialize)]
#[serde(untagged)]
enum Loose {
    Int(i64),
    Bool(bool),
    Text(String),
}

fn loose<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Loose>, D::Error> {
    Ok(match Option::<Loose>::deserialize(d)? {
        Some(Loose::Text(s)) if s.is_empty() => None,
        Some(Loose::Text(s)) => Some(s.parse().map(Loose::Int).unwrap_or(Loose::Text(s))),
        other => other,
    })
}

fn loose_u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    match loose(d)? {
        None => Ok(0),
        Some(Loose::Int(n)) => u64::try_from(n).map_err(de::Error::custom),
        Some(_) => Err(de::Error::custom("expected a count")),
    }
}

fn loose_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    match loose(d)? {
        None => Ok(false),
        Some(Loose::Bool(b)) => Ok(b),
        Some(Loose::Text(s)) => s.parse().map_err(de::Error::custom),
        Some(Loose::Int(_)) => Err(de::Error::custom("expected a boolean")),
    }
}

/// An RFC3339 time or Unix seconds; empty or zero means none.
fn ad_time<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    match loose(d)? {
        None | Some(Loose::Int(0)) => Ok(None),
        Some(Loose::Int(secs)) => secs
            .checked_mul(1000)
            .map(Some)
            .ok_or_else(|| de::Error::custom("timestamp out of range")),
        Some(Loose::Text(s)) => parse_platform_ts(&s).map(Some).map_err(de::Error::custom),
        Some(Loose::Bool(_)) => Err(de::Error::custom("expected a timestamp")),
    }
}

#[derive(Deserialize)]
struct Data<T> {
    data: Vec<T>,
}

fn first<T>(resp: Data<T>, what: &str) -> Result<T, ChannelError> {
    resp.data
        .into_iter()
        .next()
        .ok_or_else(|| ChannelError::Http {
            message: format!("empty {what} response"),
        })
}

pub async fn fetch_ad_schedule(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<AdSchedule, ChannelError> {
    let resp = helix_get(
        http,
        format!("{helix_base}/channels/ads"),
        &[("broadcaster_id", broadcaster_id)],
        access_token,
    )
    .await?;
    first(resp, "ad schedule")
}

/// Pushes the next automatic ad back 5 minutes.
pub async fn snooze_next_ad(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<AdSnooze, ChannelError> {
    let resp = http
        .post(format!("{helix_base}/channels/ads/schedule/snooze"))
        .query(&[("broadcaster_id", broadcaster_id)])
        .header("Client-Id", TWITCH_CLIENT_ID)
        .bearer_auth(access_token)
        .send()
        .await?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let message = resp.text().await.unwrap_or_default();
        return Err(match status {
            429 => ChannelError::NoSnoozesLeft { message },
            400 => ChannelError::NoAdToSnooze { message },
            status => ChannelError::Helix { status, message },
        });
    }
    first(resp.json().await?, "snooze")
}

#[derive(Serialize)]
struct CommercialBody<'a> {
    broadcaster_id: &'a str,
    length: u64,
}

/// Runs a commercial of about `length` seconds. Twitch only allows it for
/// a live affiliate or partner, and the broadcaster alone.
pub async fn start_commercial(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    length: u64,
) -> Result<Commercial, ChannelError> {
    if !(1..=COMMERCIAL_MAX_SECS).contains(&length) {
        return Err(ChannelError::InvalidSetting {
            message: format!("commercial length must be 1 to {COMMERCIAL_MAX_SECS} seconds"),
        });
    }
    let sent = helix_write(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/channels/commercial"),
        &[],
        access_token,
        &CommercialBody {
            broadcaster_id,
            length,
        },
    )
    .await;
    match sent {
        Ok(resp) => first(resp.json().await?, "commercial"),
        Err(ChannelError::Helix {
            status: 429,
            message,
        }) => {
            // The 429 does not say how long is left; the last ad from the
            // schedule does, when the token can read it.
            let retry_at = fetch_ad_schedule(http, helix_base, access_token, broadcaster_id)
                .await
                .ok()
                .and_then(|s| s.last_ad_at)
                .map(|last| last + AD_COOLDOWN_MS)
                .filter(|&at| at > chrono::Utc::now().timestamp_millis());
            Err(ChannelError::CommercialCooldown { message, retry_at })
        }
        Err(e) => Err(e),
    }
}

#[derive(Deserialize)]
struct AdBreakEvent {
    #[serde(default, deserialize_with = "loose_u64")]
    duration_seconds: u64,
    started_at: String,
    #[serde(default, deserialize_with = "loose_bool")]
    is_automatic: bool,
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    requester_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    requester_user_login: String,
    #[serde(default, deserialize_with = "null_default")]
    requester_user_name: String,
}

pub(crate) fn ad_break_from_event(event: serde_json::Value) -> Result<AdBreak, ParseError> {
    let e: AdBreakEvent = serde_json::from_value(event)?;
    Ok(AdBreak {
        channel_id: e.broadcaster_user_id,
        duration_seconds: e.duration_seconds,
        started_at: parse_platform_ts(&e.started_at)?,
        is_automatic: e.is_automatic,
        requester_id: e.requester_user_id,
        requester_login: e.requester_user_login,
        requester_name: e.requester_user_name,
    })
}

#[tauri::command]
pub async fn twitch_get_ad_schedule(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<AdSchedule, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_ad_schedule(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_snooze_next_ad(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<AdSnooze, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    snooze_next_ad(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_start_commercial(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    length: u64,
) -> Result<Commercial, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    start_commercial(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        length,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    const AT: &str = "2023-08-01T23:08:18+00:00";
    const AT_MS: i64 = 1_690_931_298_000;

    async fn schedule_from(body: serde_json::Value) -> AdSchedule {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/channels/ads")
                .query_param("broadcaster_id", "7")
                .header("Authorization", "Bearer tok");
            then.status(200)
                .json_body(serde_json::json!({ "data": [body] }));
        });
        fetch_ad_schedule(&reqwest::Client::new(), &server.base_url(), "tok", "7")
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn schedule_reads_the_documented_example() {
        let got = schedule_from(serde_json::json!({
            "next_ad_at": AT,
            "last_ad_at": AT,
            "duration": "60",
            "preroll_free_time": "90",
            "snooze_count": "1",
            "snooze_refresh_at": AT
        }))
        .await;
        assert_eq!(
            got,
            AdSchedule {
                next_ad_at: Some(AT_MS),
                last_ad_at: Some(AT_MS),
                duration: 60,
                preroll_free_time: 90,
                snooze_count: 1,
                snooze_refresh_at: Some(AT_MS),
            }
        );
    }

    #[tokio::test]
    async fn schedule_reads_integers_and_unix_seconds() {
        let got = schedule_from(serde_json::json!({
            "next_ad_at": 1_690_931_298,
            "last_ad_at": 0,
            "duration": 90,
            "preroll_free_time": 0,
            "snooze_count": 3,
            "snooze_refresh_at": ""
        }))
        .await;
        assert_eq!(got.next_ad_at, Some(AT_MS));
        assert_eq!(got.last_ad_at, None);
        assert_eq!(got.duration, 90);
        assert_eq!(got.snooze_count, 3);
        assert_eq!(got.snooze_refresh_at, None);
    }

    #[tokio::test]
    async fn offline_schedule_has_no_times() {
        let got = schedule_from(serde_json::json!({
            "next_ad_at": "",
            "last_ad_at": null,
            "duration": 0,
            "preroll_free_time": 0,
            "snooze_count": 3,
            "snooze_refresh_at": "0"
        }))
        .await;
        assert_eq!(got.next_ad_at, None);
        assert_eq!(got.last_ad_at, None);
        assert_eq!(got.snooze_refresh_at, None);
    }

    #[tokio::test]
    async fn schedule_rejects_garbage() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/channels/ads");
            then.status(200).json_body(serde_json::json!({
                "data": [{ "next_ad_at": true, "snooze_count": "many" }]
            }));
        });
        let err = fetch_ad_schedule(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Http { .. }));
    }

    #[tokio::test]
    async fn schedule_surfaces_a_missing_scope() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/channels/ads");
            then.status(401).body("missing channel:read:ads");
        });
        let err = fetch_ad_schedule(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
    }

    #[tokio::test]
    async fn empty_schedule_response_is_an_error() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/channels/ads");
            then.status(200)
                .json_body(serde_json::json!({ "data": [] }));
        });
        let err = fetch_ad_schedule(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Http { .. }));
    }

    async fn snooze_answering(status: u16, body: &str) -> Result<AdSnooze, ChannelError> {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST)
                .path("/channels/ads/schedule/snooze")
                .query_param("broadcaster_id", "7")
                .header("Authorization", "Bearer tok")
                .header("Client-Id", TWITCH_CLIENT_ID);
            then.status(status).body(body);
        });
        snooze_next_ad(&reqwest::Client::new(), &server.base_url(), "tok", "7").await
    }

    #[tokio::test]
    async fn snooze_returns_the_new_schedule() {
        let got = snooze_answering(
            200,
            &serde_json::json!({
                "data": [{ "snooze_count": "1", "snooze_refresh_at": AT, "next_ad_at": AT }]
            })
            .to_string(),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            AdSnooze {
                next_ad_at: Some(AT_MS),
                snooze_count: 1,
                snooze_refresh_at: Some(AT_MS),
            }
        );
    }

    #[tokio::test]
    async fn snooze_maps_its_documented_errors() {
        let err = snooze_answering(429, "no snoozes").await.unwrap_err();
        assert!(matches!(err, ChannelError::NoSnoozesLeft { message } if message == "no snoozes"));
        let err = snooze_answering(400, "not live").await.unwrap_err();
        assert!(matches!(err, ChannelError::NoAdToSnooze { message } if message == "not live"));
        let err = snooze_answering(401, "missing channel:manage:ads")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
    }

    #[tokio::test]
    async fn commercial_sends_the_documented_body() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/channels/commercial")
                .header("Content-Type", "application/json")
                .json_body(serde_json::json!({ "broadcaster_id": "7", "length": 60 }));
            then.status(200).json_body(serde_json::json!({
                "data": [{ "length": 60, "message": "", "retry_after": 480 }]
            }));
        });
        let got = start_commercial(&reqwest::Client::new(), &server.base_url(), "t", "7", 60)
            .await
            .unwrap();
        assert_eq!(call.calls(), 1);
        assert_eq!(
            got,
            Commercial {
                length: 60,
                message: String::new(),
                retry_after: 480,
            }
        );
    }

    #[tokio::test]
    async fn commercial_length_is_checked_before_calling_helix() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(POST).path("/channels/commercial");
            then.status(200);
        });
        let http = reqwest::Client::new();
        for length in [0, COMMERCIAL_MAX_SECS + 1] {
            let err = start_commercial(&http, &server.base_url(), "t", "7", length)
                .await
                .unwrap_err();
            assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        }
        assert_eq!(any.calls(), 0);
    }

    async fn cooldown_retry_at(schedule: Option<serde_json::Value>) -> Option<i64> {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/channels/commercial");
            then.status(429).body("cooldown");
        });
        server.mock(|when, then| {
            when.method(GET).path("/channels/ads");
            match &schedule {
                Some(s) => then
                    .status(200)
                    .json_body(serde_json::json!({ "data": [s] })),
                None => then.status(401).body("missing channel:read:ads"),
            };
        });
        let err = start_commercial(&reqwest::Client::new(), &server.base_url(), "t", "7", 30)
            .await
            .unwrap_err();
        let ChannelError::CommercialCooldown { message, retry_at } = err else {
            panic!("expected a cooldown, got {err:?}");
        };
        assert_eq!(message, "cooldown");
        retry_at
    }

    #[tokio::test]
    async fn commercial_cooldown_says_when_to_retry() {
        let last = chrono::Utc::now().timestamp() - 60;
        let at = cooldown_retry_at(Some(serde_json::json!({ "last_ad_at": last }))).await;
        assert_eq!(at, Some(last * 1000 + AD_COOLDOWN_MS));
    }

    #[tokio::test]
    async fn commercial_cooldown_without_a_known_time() {
        assert_eq!(cooldown_retry_at(None).await, None);
        let stale = chrono::Utc::now().timestamp() - 3600;
        let at = cooldown_retry_at(Some(serde_json::json!({ "last_ad_at": stale }))).await;
        assert_eq!(at, None);
    }

    #[tokio::test]
    async fn commercial_passes_other_errors_through() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/channels/commercial");
            then.status(400).body("not live");
        });
        let err = start_commercial(&reqwest::Client::new(), &server.base_url(), "t", "7", 30)
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 400, .. }));
    }

    #[test]
    fn ad_break_event_reads_the_documented_example() {
        let got = ad_break_from_event(serde_json::json!({
            "duration_seconds": "60",
            "started_at": "2019-11-16T10:11:12.634234626Z",
            "is_automatic": "false",
            "broadcaster_user_id": "1337",
            "broadcaster_user_login": "cool_user",
            "broadcaster_user_name": "Cool_User",
            "requester_user_id": "1337",
            "requester_user_login": "cool_user",
            "requester_user_name": "Cool_User"
        }))
        .unwrap();
        assert_eq!(
            got,
            AdBreak {
                channel_id: "1337".into(),
                duration_seconds: 60,
                started_at: 1_573_899_072_634,
                is_automatic: false,
                requester_id: "1337".into(),
                requester_login: "cool_user".into(),
                requester_name: "Cool_User".into(),
            }
        );
    }

    #[test]
    fn ad_break_event_reads_typed_fields() {
        let got = ad_break_from_event(serde_json::json!({
            "duration_seconds": 90,
            "started_at": "2019-11-16T10:11:12Z",
            "is_automatic": true,
            "broadcaster_user_id": "1337",
            "requester_user_id": null
        }))
        .unwrap();
        assert_eq!(got.duration_seconds, 90);
        assert!(got.is_automatic);
        assert_eq!(got.requester_id, "");
        assert!(ad_break_from_event(serde_json::json!({
            "started_at": "2019-11-16T10:11:12Z",
            "is_automatic": 1
        }))
        .is_err());
        assert!(ad_break_from_event(serde_json::json!({ "started_at": "yesterday" })).is_err());
    }
}
