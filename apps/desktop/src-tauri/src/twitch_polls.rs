//! Polls and Channel Points Predictions on the signed-in broadcaster's own
//! channel. Helix `/polls` and `/predictions` read, create and end them
//! (scopes `channel:manage:polls` and `channel:manage:predictions`, which
//! also cover reading and the EventSub feeds). The `channel.poll.*` and
//! `channel.prediction.*` v1 notifications keep the open one live; both
//! sources map onto [`Poll`] and [`Prediction`] with lowercase statuses
//! and Unix millisecond timestamps.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::message::{null_default, parse_platform_ts, ParseError};
use crate::twitch_auth::AuthState;
use crate::twitch_channel::{check_text, helix_get, helix_write, ChannelError, ChannelState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PollChoice {
    pub id: String,
    pub title: String,
    /// Every vote, Channel Points ones included.
    #[serde(default, deserialize_with = "null_default")]
    pub votes: u64,
    #[serde(default, deserialize_with = "null_default")]
    pub channel_points_votes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Poll {
    pub id: String,
    pub channel_id: String,
    pub title: String,
    pub choices: Vec<PollChoice>,
    pub channel_points_voting_enabled: bool,
    pub channel_points_per_vote: u64,
    /// `active`, `completed`, `terminated`, `archived`, `moderated` or
    /// `invalid`.
    pub status: String,
    pub started_at: i64,
    /// Scheduled end. An end notification does not carry it.
    pub ends_at: Option<i64>,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PredictionOutcome {
    pub id: String,
    pub title: String,
    /// `blue` or `pink`.
    pub color: String,
    /// Viewers who predicted this outcome.
    pub users: u64,
    pub channel_points: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Prediction {
    pub id: String,
    pub channel_id: String,
    pub title: String,
    pub outcomes: Vec<PredictionOutcome>,
    /// `active`, `locked`, `resolved` or `canceled`.
    pub status: String,
    pub winning_outcome_id: Option<String>,
    pub started_at: i64,
    /// When the prediction window closes. Lock and end notifications do
    /// not carry it.
    pub locks_at: Option<i64>,
    pub locked_at: Option<i64>,
    pub ended_at: Option<i64>,
}

/// Limits from the Create Poll and Create Prediction references.
pub const POLL_TITLE_MAX_CHARS: usize = 60;
pub const POLL_CHOICE_MAX_CHARS: usize = 25;
pub const POLL_CHOICES: (usize, usize) = (2, 5);
pub const POLL_DURATION_SECS: (u64, u64) = (15, 1800);
pub const POLL_POINTS_PER_VOTE: (u64, u64) = (1, 1_000_000);
pub const PREDICTION_TITLE_MAX_CHARS: usize = 45;
pub const PREDICTION_OUTCOME_MAX_CHARS: usize = 25;
pub const PREDICTION_OUTCOMES: (usize, usize) = (2, 10);
pub const PREDICTION_WINDOW_SECS: (u64, u64) = (30, 1800);

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NewPoll {
    pub title: String,
    pub choices: Vec<String>,
    pub duration: u64,
    /// Extra votes for this many Channel Points each; `None` allows one
    /// free vote per viewer only.
    #[serde(default)]
    pub channel_points_per_vote: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NewPrediction {
    pub title: String,
    pub outcomes: Vec<String>,
    pub prediction_window: u64,
}

fn invalid(message: String) -> ChannelError {
    ChannelError::InvalidSetting { message }
}

fn check_range(field: &str, value: u64, (min, max): (u64, u64)) -> Result<(), ChannelError> {
    if value < min || value > max {
        return Err(invalid(format!("{field} must be {min} to {max}")));
    }
    Ok(())
}

fn check_options(
    field: &str,
    options: &[String],
    (min, max): (usize, usize),
    max_chars: usize,
) -> Result<(), ChannelError> {
    if options.len() < min || options.len() > max {
        return Err(invalid(format!("{min} to {max} {field}s are needed")));
    }
    options
        .iter()
        .try_for_each(|o| check_text(field, o, max_chars))
}

pub fn validate_poll(p: &NewPoll) -> Result<(), ChannelError> {
    check_text("poll title", &p.title, POLL_TITLE_MAX_CHARS)?;
    check_options("choice", &p.choices, POLL_CHOICES, POLL_CHOICE_MAX_CHARS)?;
    check_range("poll duration in seconds", p.duration, POLL_DURATION_SECS)?;
    if let Some(points) = p.channel_points_per_vote {
        check_range("Channel Points per vote", points, POLL_POINTS_PER_VOTE)?;
    }
    Ok(())
}

pub fn validate_prediction(p: &NewPrediction) -> Result<(), ChannelError> {
    check_text("prediction title", &p.title, PREDICTION_TITLE_MAX_CHARS)?;
    check_options(
        "outcome",
        &p.outcomes,
        PREDICTION_OUTCOMES,
        PREDICTION_OUTCOME_MAX_CHARS,
    )?;
    check_range(
        "prediction window in seconds",
        p.prediction_window,
        PREDICTION_WINDOW_SECS,
    )
}

fn optional_ts(value: Option<String>) -> Result<Option<i64>, ParseError> {
    value
        .filter(|s| !s.is_empty())
        .map(|s| parse_platform_ts(&s))
        .transpose()
}

fn secs_after(start_ms: i64, secs: u64) -> Option<i64> {
    i64::try_from(secs)
        .ok()
        .and_then(|s| s.checked_mul(1000))
        .and_then(|ms| start_ms.checked_add(ms))
}

// --- Helix ---

#[derive(Deserialize)]
struct HelixPoll {
    id: String,
    broadcaster_id: String,
    title: String,
    #[serde(default, deserialize_with = "null_default")]
    choices: Vec<PollChoice>,
    #[serde(default)]
    channel_points_voting_enabled: bool,
    #[serde(default)]
    channel_points_per_vote: u64,
    status: String,
    #[serde(default)]
    duration: u64,
    started_at: String,
    #[serde(default)]
    ended_at: Option<String>,
}

#[derive(Deserialize)]
struct PollsResponse {
    data: Vec<HelixPoll>,
}

impl TryFrom<HelixPoll> for Poll {
    type Error = ParseError;

    fn try_from(p: HelixPoll) -> Result<Self, ParseError> {
        let started_at = parse_platform_ts(&p.started_at)?;
        Ok(Poll {
            id: p.id,
            channel_id: p.broadcaster_id,
            title: p.title,
            choices: p.choices,
            channel_points_voting_enabled: p.channel_points_voting_enabled,
            channel_points_per_vote: p.channel_points_per_vote,
            status: p.status.to_ascii_lowercase(),
            started_at,
            ends_at: secs_after(started_at, p.duration),
            ended_at: optional_ts(p.ended_at)?,
        })
    }
}

#[derive(Deserialize)]
struct RawOutcome {
    id: String,
    #[serde(default, deserialize_with = "null_default")]
    title: String,
    #[serde(default, deserialize_with = "null_default")]
    color: String,
    #[serde(default, deserialize_with = "null_default")]
    users: u64,
    #[serde(default, deserialize_with = "null_default")]
    channel_points: u64,
}

impl From<RawOutcome> for PredictionOutcome {
    fn from(o: RawOutcome) -> Self {
        PredictionOutcome {
            id: o.id,
            title: o.title,
            color: o.color.to_ascii_lowercase(),
            users: o.users,
            channel_points: o.channel_points,
        }
    }
}

#[derive(Deserialize)]
struct HelixPrediction {
    id: String,
    broadcaster_id: String,
    title: String,
    #[serde(default)]
    winning_outcome_id: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    outcomes: Vec<RawOutcome>,
    #[serde(default)]
    prediction_window: u64,
    status: String,
    created_at: String,
    #[serde(default)]
    ended_at: Option<String>,
    #[serde(default)]
    locked_at: Option<String>,
}

#[derive(Deserialize)]
struct PredictionsResponse {
    data: Vec<HelixPrediction>,
}

impl TryFrom<HelixPrediction> for Prediction {
    type Error = ParseError;

    fn try_from(p: HelixPrediction) -> Result<Self, ParseError> {
        let started_at = parse_platform_ts(&p.created_at)?;
        Ok(Prediction {
            id: p.id,
            channel_id: p.broadcaster_id,
            title: p.title,
            outcomes: p.outcomes.into_iter().map(Into::into).collect(),
            status: p.status.to_ascii_lowercase(),
            winning_outcome_id: p.winning_outcome_id.filter(|s| !s.is_empty()),
            started_at,
            locks_at: secs_after(started_at, p.prediction_window),
            locked_at: optional_ts(p.locked_at)?,
            ended_at: optional_ts(p.ended_at)?,
        })
    }
}

fn first<H, T>(data: Vec<H>, what: &str) -> Result<T, ChannelError>
where
    T: TryFrom<H, Error = ParseError>,
{
    let item = data.into_iter().next().ok_or_else(|| ChannelError::Http {
        message: format!("empty {what} response"),
    })?;
    Ok(T::try_from(item)?)
}

#[derive(Serialize)]
struct TitleOnly<'a> {
    title: &'a str,
}

#[derive(Serialize)]
struct CreatePollBody<'a> {
    broadcaster_id: &'a str,
    title: &'a str,
    choices: Vec<TitleOnly<'a>>,
    duration: u64,
    channel_points_voting_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_points_per_vote: Option<u64>,
}

#[derive(Serialize)]
struct EndBody<'a> {
    broadcaster_id: &'a str,
    id: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    winning_outcome_id: Option<&'a str>,
}

#[derive(Serialize)]
struct CreatePredictionBody<'a> {
    broadcaster_id: &'a str,
    title: &'a str,
    outcomes: Vec<TitleOnly<'a>>,
    prediction_window: u64,
}

/// The broadcaster's most recent poll (Helix keeps them 90 days), or
/// `None` if they never ran one.
pub async fn fetch_latest_poll(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<Option<Poll>, ChannelError> {
    let resp: PollsResponse = helix_get(
        http,
        format!("{helix_base}/polls"),
        &[("broadcaster_id", broadcaster_id), ("first", "1")],
        access_token,
    )
    .await?;
    match resp.data.into_iter().next() {
        Some(p) => Ok(Some(p.try_into()?)),
        None => Ok(None),
    }
}

pub async fn create_poll(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    poll: &NewPoll,
) -> Result<Poll, ChannelError> {
    validate_poll(poll)?;
    let body = CreatePollBody {
        broadcaster_id,
        title: &poll.title,
        choices: poll
            .choices
            .iter()
            .map(|c| TitleOnly { title: c })
            .collect(),
        duration: poll.duration,
        channel_points_voting_enabled: poll.channel_points_per_vote.is_some(),
        channel_points_per_vote: poll.channel_points_per_vote,
    };
    let resp: PollsResponse = helix_write(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/polls"),
        &[],
        access_token,
        &body,
    )
    .await?
    .json()
    .await?;
    first(resp.data, "poll")
}

/// Ends the running poll early. `archive` also hides it from the channel.
pub async fn end_poll(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    poll_id: &str,
    archive: bool,
) -> Result<Poll, ChannelError> {
    let body = EndBody {
        broadcaster_id,
        id: poll_id,
        status: if archive { "ARCHIVED" } else { "TERMINATED" },
        winning_outcome_id: None,
    };
    let resp: PollsResponse = helix_write(
        http,
        reqwest::Method::PATCH,
        format!("{helix_base}/polls"),
        &[],
        access_token,
        &body,
    )
    .await?
    .json()
    .await?;
    first(resp.data, "poll")
}

/// The broadcaster's most recent prediction, or `None` if they never ran
/// one.
pub async fn fetch_latest_prediction(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<Option<Prediction>, ChannelError> {
    let resp: PredictionsResponse = helix_get(
        http,
        format!("{helix_base}/predictions"),
        &[("broadcaster_id", broadcaster_id), ("first", "1")],
        access_token,
    )
    .await?;
    match resp.data.into_iter().next() {
        Some(p) => Ok(Some(p.try_into()?)),
        None => Ok(None),
    }
}

pub async fn create_prediction(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    prediction: &NewPrediction,
) -> Result<Prediction, ChannelError> {
    validate_prediction(prediction)?;
    let body = CreatePredictionBody {
        broadcaster_id,
        title: &prediction.title,
        outcomes: prediction
            .outcomes
            .iter()
            .map(|o| TitleOnly { title: o })
            .collect(),
        prediction_window: prediction.prediction_window,
    };
    let resp: PredictionsResponse = helix_write(
        http,
        reqwest::Method::POST,
        format!("{helix_base}/predictions"),
        &[],
        access_token,
        &body,
    )
    .await?
    .json()
    .await?;
    first(resp.data, "prediction")
}

/// What to do with a running prediction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredictionEnd<'a> {
    /// Stop taking predictions; the result comes later.
    Lock,
    /// Pay out to the viewers who picked this outcome.
    Resolve(&'a str),
    /// Refund every viewer.
    Cancel,
}

pub async fn end_prediction(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    prediction_id: &str,
    end: PredictionEnd<'_>,
) -> Result<Prediction, ChannelError> {
    let (status, winning_outcome_id) = match end {
        PredictionEnd::Lock => ("LOCKED", None),
        PredictionEnd::Resolve(outcome) => {
            if outcome.is_empty() {
                return Err(invalid("pick the winning outcome".into()));
            }
            ("RESOLVED", Some(outcome))
        }
        PredictionEnd::Cancel => ("CANCELED", None),
    };
    let body = EndBody {
        broadcaster_id,
        id: prediction_id,
        status,
        winning_outcome_id,
    };
    let resp: PredictionsResponse = helix_write(
        http,
        reqwest::Method::PATCH,
        format!("{helix_base}/predictions"),
        &[],
        access_token,
        &body,
    )
    .await?
    .json()
    .await?;
    first(resp.data, "prediction")
}

// --- EventSub ---

#[derive(Deserialize)]
struct VotingSettings {
    #[serde(default, deserialize_with = "null_default")]
    is_enabled: bool,
    #[serde(default, deserialize_with = "null_default")]
    amount_per_vote: u64,
}

#[derive(Deserialize)]
struct PollEvent {
    id: String,
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    title: String,
    #[serde(default, deserialize_with = "null_default")]
    choices: Vec<PollChoice>,
    #[serde(default)]
    channel_points_voting: Option<VotingSettings>,
    #[serde(default, deserialize_with = "null_default")]
    status: String,
    started_at: String,
    #[serde(default)]
    ends_at: Option<String>,
    #[serde(default)]
    ended_at: Option<String>,
}

/// Maps a `channel.poll.begin`, `.progress` or `.end` v1 event. Only the
/// end event says how the poll finished; the others mean it is running.
pub(crate) fn poll_from_event(
    sub_type: &str,
    event: serde_json::Value,
) -> Result<Poll, ParseError> {
    let e: PollEvent = serde_json::from_value(event)?;
    let status = if sub_type == "channel.poll.end" {
        e.status.to_ascii_lowercase()
    } else {
        "active".into()
    };
    let (enabled, per_vote) = e
        .channel_points_voting
        .map(|v| (v.is_enabled, v.amount_per_vote))
        .unwrap_or_default();
    Ok(Poll {
        id: e.id,
        channel_id: e.broadcaster_user_id,
        title: e.title,
        choices: e.choices,
        channel_points_voting_enabled: enabled,
        channel_points_per_vote: per_vote,
        status,
        started_at: parse_platform_ts(&e.started_at)?,
        ends_at: optional_ts(e.ends_at)?,
        ended_at: optional_ts(e.ended_at)?,
    })
}

#[derive(Deserialize)]
struct PredictionEvent {
    id: String,
    #[serde(default, deserialize_with = "null_default")]
    broadcaster_user_id: String,
    #[serde(default, deserialize_with = "null_default")]
    title: String,
    #[serde(default, deserialize_with = "null_default")]
    outcomes: Vec<RawOutcome>,
    #[serde(default)]
    winning_outcome_id: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    status: String,
    started_at: String,
    #[serde(default)]
    locks_at: Option<String>,
    #[serde(default)]
    locked_at: Option<String>,
    #[serde(default)]
    ended_at: Option<String>,
}

/// Maps a `channel.prediction.begin`, `.progress`, `.lock` or `.end` v1
/// event. The status is implied by the type except on end, which says
/// whether it resolved or was canceled.
pub(crate) fn prediction_from_event(
    sub_type: &str,
    event: serde_json::Value,
) -> Result<Prediction, ParseError> {
    let e: PredictionEvent = serde_json::from_value(event)?;
    let status = match sub_type {
        "channel.prediction.end" => e.status.to_ascii_lowercase(),
        "channel.prediction.lock" => "locked".into(),
        _ => "active".into(),
    };
    Ok(Prediction {
        id: e.id,
        channel_id: e.broadcaster_user_id,
        title: e.title,
        outcomes: e.outcomes.into_iter().map(Into::into).collect(),
        status,
        winning_outcome_id: e.winning_outcome_id.filter(|s| !s.is_empty()),
        started_at: parse_platform_ts(&e.started_at)?,
        locks_at: optional_ts(e.locks_at)?,
        locked_at: optional_ts(e.locked_at)?,
        ended_at: optional_ts(e.ended_at)?,
    })
}

// --- Commands ---

#[tauri::command]
pub async fn twitch_get_poll(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<Option<Poll>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_latest_poll(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_create_poll(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    poll: NewPoll,
) -> Result<Poll, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    create_poll(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &poll,
    )
    .await
}

#[tauri::command]
pub async fn twitch_end_poll(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    poll_id: String,
    archive: bool,
) -> Result<Poll, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    end_poll(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &poll_id,
        archive,
    )
    .await
}

#[tauri::command]
pub async fn twitch_get_prediction(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<Option<Prediction>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_latest_prediction(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_create_prediction(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    prediction: NewPrediction,
) -> Result<Prediction, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    create_prediction(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &prediction,
    )
    .await
}

async fn finish_prediction(
    auth: &AuthState,
    channels: &ChannelState,
    prediction_id: &str,
    end: PredictionEnd<'_>,
) -> Result<Prediction, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    end_prediction(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        prediction_id,
        end,
    )
    .await
}

#[tauri::command]
pub async fn twitch_lock_prediction(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    prediction_id: String,
) -> Result<Prediction, ChannelError> {
    finish_prediction(&auth, &channels, &prediction_id, PredictionEnd::Lock).await
}

#[tauri::command]
pub async fn twitch_resolve_prediction(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    prediction_id: String,
    winning_outcome_id: String,
) -> Result<Prediction, ChannelError> {
    finish_prediction(
        &auth,
        &channels,
        &prediction_id,
        PredictionEnd::Resolve(&winning_outcome_id),
    )
    .await
}

#[tauri::command]
pub async fn twitch_cancel_prediction(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    prediction_id: String,
) -> Result<Prediction, ChannelError> {
    finish_prediction(&auth, &channels, &prediction_id, PredictionEnd::Cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    const STARTED: &str = "2021-03-19T06:08:33.871278372Z";
    const STARTED_MS: i64 = 1_616_134_113_871;

    fn helix_poll(status: &str, ended_at: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "data": [{
                "id": "poll-1",
                "broadcaster_id": "7",
                "broadcaster_name": "Me",
                "broadcaster_login": "me",
                "title": "Heads or Tails?",
                "choices": [
                    { "id": "c1", "title": "Heads", "votes": 3, "channel_points_votes": 1, "bits_votes": 0 },
                    { "id": "c2", "title": "Tails", "votes": 0, "channel_points_votes": 0, "bits_votes": 0 }
                ],
                "bits_voting_enabled": false,
                "bits_per_vote": 0,
                "channel_points_voting_enabled": true,
                "channel_points_per_vote": 100,
                "status": status,
                "duration": 1800,
                "started_at": STARTED,
                "ended_at": ended_at
            }]
        })
    }

    fn helix_prediction(status: &str, winner: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "data": [{
                "id": "pred-1",
                "broadcaster_id": "7",
                "broadcaster_name": "Me",
                "broadcaster_login": "me",
                "title": "Any leeks in the stream?",
                "winning_outcome_id": winner,
                "outcomes": [
                    { "id": "o1", "title": "Yes", "users": 2, "channel_points": 500, "top_predictors": null, "color": "BLUE" },
                    { "id": "o2", "title": "No", "users": 0, "channel_points": 0, "top_predictors": null, "color": "PINK" }
                ],
                "prediction_window": 120,
                "status": status,
                "created_at": STARTED,
                "ended_at": null,
                "locked_at": null
            }]
        })
    }

    fn new_poll() -> NewPoll {
        NewPoll {
            title: "Heads or Tails?".into(),
            choices: vec!["Heads".into(), "Tails".into()],
            duration: 1800,
            channel_points_per_vote: Some(100),
        }
    }

    fn new_prediction() -> NewPrediction {
        NewPrediction {
            title: "Any leeks in the stream?".into(),
            outcomes: vec!["Yes".into(), "No".into()],
            prediction_window: 120,
        }
    }

    #[tokio::test]
    async fn latest_poll_reads_the_newest_one() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/polls")
                .query_param("broadcaster_id", "7")
                .query_param("first", "1");
            then.status(200).json_body(helix_poll("ACTIVE", None));
        });
        let poll = fetch_latest_poll(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            poll,
            Poll {
                id: "poll-1".into(),
                channel_id: "7".into(),
                title: "Heads or Tails?".into(),
                choices: vec![
                    PollChoice {
                        id: "c1".into(),
                        title: "Heads".into(),
                        votes: 3,
                        channel_points_votes: 1,
                    },
                    PollChoice {
                        id: "c2".into(),
                        title: "Tails".into(),
                        votes: 0,
                        channel_points_votes: 0,
                    },
                ],
                channel_points_voting_enabled: true,
                channel_points_per_vote: 100,
                status: "active".into(),
                started_at: STARTED_MS,
                ends_at: Some(STARTED_MS + 1_800_000),
                ended_at: None,
            }
        );
    }

    #[tokio::test]
    async fn latest_poll_is_none_without_polls() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/polls");
            then.status(200)
                .json_body(serde_json::json!({ "data": [], "pagination": {} }));
        });
        let got = fetch_latest_poll(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap();
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn create_poll_sends_the_documented_body() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/polls")
                .header("Content-Type", "application/json")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7",
                    "title": "Heads or Tails?",
                    "choices": [{ "title": "Heads" }, { "title": "Tails" }],
                    "duration": 1800,
                    "channel_points_voting_enabled": true,
                    "channel_points_per_vote": 100
                }));
            then.status(200).json_body(helix_poll("ACTIVE", None));
        });
        let poll = create_poll(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "7",
            &new_poll(),
        )
        .await
        .unwrap();
        assert_eq!(call.calls(), 1);
        assert_eq!(poll.id, "poll-1");
    }

    #[tokio::test]
    async fn create_poll_without_points_leaves_them_off() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/polls")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7",
                    "title": "Heads or Tails?",
                    "choices": [{ "title": "Heads" }, { "title": "Tails" }],
                    "duration": 15,
                    "channel_points_voting_enabled": false
                }));
            then.status(200).json_body(helix_poll("ACTIVE", None));
        });
        let poll = NewPoll {
            duration: 15,
            channel_points_per_vote: None,
            ..new_poll()
        };
        create_poll(&reqwest::Client::new(), &server.base_url(), "t", "7", &poll)
            .await
            .unwrap();
        assert_eq!(call.calls(), 1);
    }

    #[test]
    fn poll_limits_match_the_reference() {
        assert!(validate_poll(&new_poll()).is_ok());
        let bad = [
            NewPoll {
                title: "x".repeat(61),
                ..new_poll()
            },
            NewPoll {
                title: " ".into(),
                ..new_poll()
            },
            NewPoll {
                choices: vec!["one".into()],
                ..new_poll()
            },
            NewPoll {
                choices: (0..6).map(|i| i.to_string()).collect(),
                ..new_poll()
            },
            NewPoll {
                choices: vec!["a".into(), "x".repeat(26)],
                ..new_poll()
            },
            NewPoll {
                choices: vec!["a".into(), "".into()],
                ..new_poll()
            },
            NewPoll {
                duration: 14,
                ..new_poll()
            },
            NewPoll {
                duration: 1801,
                ..new_poll()
            },
            NewPoll {
                channel_points_per_vote: Some(0),
                ..new_poll()
            },
            NewPoll {
                channel_points_per_vote: Some(1_000_001),
                ..new_poll()
            },
        ];
        for p in bad {
            assert!(
                matches!(validate_poll(&p), Err(ChannelError::InvalidSetting { .. })),
                "{p:?}"
            );
        }
        let edges = NewPoll {
            title: "x".repeat(60),
            choices: (0..5).map(|_| "y".repeat(25)).collect(),
            duration: 15,
            channel_points_per_vote: Some(1_000_000),
        };
        assert!(validate_poll(&edges).is_ok());
    }

    #[tokio::test]
    async fn end_poll_terminates_or_archives() {
        let server = MockServer::start_async().await;
        let terminate = server.mock(|when, then| {
            when.method(PATCH)
                .path("/polls")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7", "id": "poll-1", "status": "TERMINATED"
                }));
            then.status(200).json_body(helix_poll(
                "TERMINATED",
                Some("2021-03-19T06:11:26.746889614Z"),
            ));
        });
        let archive = server.mock(|when, then| {
            when.method(PATCH)
                .path("/polls")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7", "id": "poll-1", "status": "ARCHIVED"
                }));
            then.status(200).json_body(helix_poll(
                "ARCHIVED",
                Some("2021-03-19T06:11:26.746889614Z"),
            ));
        });
        let http = reqwest::Client::new();
        let ended = end_poll(&http, &server.base_url(), "t", "7", "poll-1", false)
            .await
            .unwrap();
        assert_eq!(ended.status, "terminated");
        assert_eq!(ended.ended_at, Some(1_616_134_286_746));
        let archived = end_poll(&http, &server.base_url(), "t", "7", "poll-1", true)
            .await
            .unwrap();
        assert_eq!(archived.status, "archived");
        assert_eq!((terminate.calls(), archive.calls()), (1, 1));
    }

    #[tokio::test]
    async fn create_poll_surfaces_helix_errors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(POST).path("/polls");
            then.status(400).body("poll already running");
        });
        let err = create_poll(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "7",
            &new_poll(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 400, .. }));
    }

    #[tokio::test]
    async fn latest_prediction_maps_statuses_and_colors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/predictions")
                .query_param("broadcaster_id", "7")
                .query_param("first", "1");
            then.status(200).json_body(helix_prediction("ACTIVE", None));
        });
        let p = fetch_latest_prediction(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            p,
            Prediction {
                id: "pred-1".into(),
                channel_id: "7".into(),
                title: "Any leeks in the stream?".into(),
                outcomes: vec![
                    PredictionOutcome {
                        id: "o1".into(),
                        title: "Yes".into(),
                        color: "blue".into(),
                        users: 2,
                        channel_points: 500,
                    },
                    PredictionOutcome {
                        id: "o2".into(),
                        title: "No".into(),
                        color: "pink".into(),
                        users: 0,
                        channel_points: 0,
                    },
                ],
                status: "active".into(),
                winning_outcome_id: None,
                started_at: STARTED_MS,
                locks_at: Some(STARTED_MS + 120_000),
                locked_at: None,
                ended_at: None,
            }
        );
    }

    #[tokio::test]
    async fn create_prediction_sends_the_documented_body() {
        let server = MockServer::start_async().await;
        let call = server.mock(|when, then| {
            when.method(POST)
                .path("/predictions")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7",
                    "title": "Any leeks in the stream?",
                    "outcomes": [{ "title": "Yes" }, { "title": "No" }],
                    "prediction_window": 120
                }));
            then.status(200).json_body(helix_prediction("ACTIVE", None));
        });
        let p = create_prediction(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "7",
            &new_prediction(),
        )
        .await
        .unwrap();
        assert_eq!(call.calls(), 1);
        assert_eq!(p.id, "pred-1");
    }

    #[test]
    fn prediction_limits_match_the_reference() {
        assert!(validate_prediction(&new_prediction()).is_ok());
        let bad = [
            NewPrediction {
                title: "x".repeat(46),
                ..new_prediction()
            },
            NewPrediction {
                outcomes: vec!["only".into()],
                ..new_prediction()
            },
            NewPrediction {
                outcomes: (0..11).map(|i| i.to_string()).collect(),
                ..new_prediction()
            },
            NewPrediction {
                outcomes: vec!["a".into(), "x".repeat(26)],
                ..new_prediction()
            },
            NewPrediction {
                prediction_window: 29,
                ..new_prediction()
            },
            NewPrediction {
                prediction_window: 1801,
                ..new_prediction()
            },
        ];
        for p in bad {
            assert!(
                matches!(
                    validate_prediction(&p),
                    Err(ChannelError::InvalidSetting { .. })
                ),
                "{p:?}"
            );
        }
        let edges = NewPrediction {
            title: "x".repeat(45),
            outcomes: (0..10).map(|_| "y".repeat(25)).collect(),
            prediction_window: 1800,
        };
        assert!(validate_prediction(&edges).is_ok());
    }

    #[tokio::test]
    async fn end_prediction_sends_each_status() {
        let server = MockServer::start_async().await;
        let lock = server.mock(|when, then| {
            when.method(PATCH)
                .path("/predictions")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7", "id": "pred-1", "status": "LOCKED"
                }));
            then.status(200).json_body(helix_prediction("LOCKED", None));
        });
        let resolve = server.mock(|when, then| {
            when.method(PATCH).path("/predictions").json_body(serde_json::json!({
                "broadcaster_id": "7", "id": "pred-1", "status": "RESOLVED", "winning_outcome_id": "o1"
            }));
            then.status(200)
                .json_body(helix_prediction("RESOLVED", Some("o1")));
        });
        let cancel = server.mock(|when, then| {
            when.method(PATCH)
                .path("/predictions")
                .json_body(serde_json::json!({
                    "broadcaster_id": "7", "id": "pred-1", "status": "CANCELED"
                }));
            then.status(200)
                .json_body(helix_prediction("CANCELED", None));
        });
        let http = reqwest::Client::new();
        let base = server.base_url();
        let locked = end_prediction(&http, &base, "t", "7", "pred-1", PredictionEnd::Lock)
            .await
            .unwrap();
        assert_eq!(locked.status, "locked");
        let resolved = end_prediction(
            &http,
            &base,
            "t",
            "7",
            "pred-1",
            PredictionEnd::Resolve("o1"),
        )
        .await
        .unwrap();
        assert_eq!(resolved.status, "resolved");
        assert_eq!(resolved.winning_outcome_id.as_deref(), Some("o1"));
        let canceled = end_prediction(&http, &base, "t", "7", "pred-1", PredictionEnd::Cancel)
            .await
            .unwrap();
        assert_eq!(canceled.status, "canceled");
        assert_eq!((lock.calls(), resolve.calls(), cancel.calls()), (1, 1, 1));

        let err = end_prediction(&http, &base, "t", "7", "pred-1", PredictionEnd::Resolve(""))
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        assert_eq!(resolve.calls(), 1);
    }

    #[test]
    fn poll_events_carry_votes_and_the_end_status() {
        let begin = poll_from_event(
            "channel.poll.begin",
            serde_json::json!({
                "id": "1243456",
                "broadcaster_user_id": "1337",
                "broadcaster_user_login": "cool_user",
                "broadcaster_user_name": "Cool_User",
                "title": "Aren't shoes just really hard socks?",
                "choices": [{ "id": "123", "title": "Yeah!" }, { "id": "124", "title": "No!" }],
                "bits_voting": { "is_enabled": false, "amount_per_vote": 0 },
                "channel_points_voting": { "is_enabled": true, "amount_per_vote": 10 },
                "started_at": "2020-07-15T17:16:03.17106713Z",
                "ends_at": "2020-07-15T17:16:08.17106713Z"
            }),
        )
        .unwrap();
        assert_eq!(begin.status, "active");
        assert_eq!(begin.channel_id, "1337");
        assert_eq!(begin.choices[0].votes, 0);
        assert!(begin.channel_points_voting_enabled);
        assert_eq!(begin.channel_points_per_vote, 10);
        assert_eq!(begin.ends_at, Some(begin.started_at + 5000));

        let end = poll_from_event(
            "channel.poll.end",
            serde_json::json!({
                "id": "1243456",
                "broadcaster_user_id": "1337",
                "title": "Aren't shoes just really hard socks?",
                "choices": [
                    { "id": "123", "title": "Blue", "bits_votes": 0, "channel_points_votes": 70, "votes": 120 },
                    { "id": "124", "title": "Yellow", "bits_votes": 0, "channel_points_votes": 40, "votes": 140 }
                ],
                "channel_points_voting": null,
                "status": "completed",
                "started_at": "2020-07-15T17:16:03.17106713Z",
                "ended_at": "2020-07-15T17:16:11.17106713Z"
            }),
        )
        .unwrap();
        assert_eq!(end.status, "completed");
        assert_eq!(end.choices[1].votes, 140);
        assert_eq!(end.choices[1].channel_points_votes, 40);
        assert!(!end.channel_points_voting_enabled);
        assert_eq!(end.ends_at, None);
        assert_eq!(end.ended_at, Some(end.started_at + 8000));
    }

    #[test]
    fn prediction_events_imply_status_by_type() {
        let outcomes = serde_json::json!([
            {
                "id": "1243456", "title": "Yeah!", "color": "blue", "users": 10, "channel_points": 15000,
                "top_predictors": [{ "user_name": "Cool_User", "user_login": "cool_user", "user_id": "1234", "channel_points_won": null, "channel_points_used": 500 }]
            },
            // Twitch's own example omits the totals here and sends a numeric user id.
            {
                "id": "2243456", "title": "No!", "color": "pink",
                "top_predictors": [{ "user_name": "Cooler_User", "user_login": "cooler_user", "user_id": 12345, "channel_points_won": null, "channel_points_used": 5000 }]
            }
        ]);
        let event = |extra: serde_json::Value| {
            let mut e = serde_json::json!({
                "id": "1243456",
                "broadcaster_user_id": "1337",
                "broadcaster_user_login": "cool_user",
                "broadcaster_user_name": "Cool_User",
                "title": "Aren't shoes just really hard socks?",
                "outcomes": outcomes,
                "started_at": "2020-07-15T17:16:03.17106713Z"
            });
            e.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            e
        };

        let progress = prediction_from_event(
            "channel.prediction.progress",
            event(serde_json::json!({ "locks_at": "2020-07-15T17:21:03.17106713Z" })),
        )
        .unwrap();
        assert_eq!(progress.status, "active");
        assert_eq!(progress.locks_at, Some(progress.started_at + 300_000));
        assert_eq!(progress.outcomes[0].users, 10);
        assert_eq!(progress.outcomes[0].channel_points, 15000);
        assert_eq!(progress.outcomes[1].users, 0);
        assert_eq!(progress.outcomes[1].color, "pink");

        let lock = prediction_from_event(
            "channel.prediction.lock",
            event(serde_json::json!({ "locked_at": "2020-07-15T17:21:03.17106713Z" })),
        )
        .unwrap();
        assert_eq!(lock.status, "locked");
        assert_eq!(lock.locked_at, Some(lock.started_at + 300_000));

        let end = prediction_from_event(
            "channel.prediction.end",
            event(serde_json::json!({
                "winning_outcome_id": "1243456",
                "status": "resolved",
                "ended_at": "2020-07-15T17:16:11.17106713Z"
            })),
        )
        .unwrap();
        assert_eq!(end.status, "resolved");
        assert_eq!(end.winning_outcome_id.as_deref(), Some("1243456"));

        let canceled = prediction_from_event(
            "channel.prediction.end",
            event(serde_json::json!({ "winning_outcome_id": null, "status": "canceled" })),
        )
        .unwrap();
        assert_eq!(canceled.status, "canceled");
        assert_eq!(canceled.winning_outcome_id, None);
    }
}
