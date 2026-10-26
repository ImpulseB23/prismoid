//! Active Twitch channel selection.
//!
//! The signed-in account is the *chatter*; the channel whose chat we read
//! is independent and can be any Twitch broadcaster. The frontend picks a
//! channel by login, we resolve it to a broadcaster id via Helix
//! `GET /users`, and publish it on a `tokio::sync::watch` channel. The
//! sidecar supervisor observes that watch and re-points the EventSub
//! subscription (disconnect old, connect new) whenever it changes, so the
//! command never races the supervisor over who writes to the sidecar.
//!
//! `None` on the watch means "no explicit selection yet": the supervisor
//! falls back to the signed-in user's own channel.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::watch;

use crate::twitch_auth::{AuthError, AuthState, TWITCH_CLIENT_ID};

pub const HELIX_BASE: &str = "https://api.twitch.tv/helix";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub profile_image_url: String,
}

pub struct ChannelState {
    tx: watch::Sender<ChannelSelection>,
    helix_base: String,
    followers: FollowerCache,
    followed: FollowedCache,
}

/// What the sidecar supervisor watches: every channel to keep joined, in
/// tab order, and the one the window shows. An empty `joined` means the
/// signed-in user's own channel.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChannelSelection {
    pub joined: Vec<JoinedChannel>,
    pub focused: Option<Channel>,
}

/// A joined channel plus a counter that [`ChannelState::rejoin`] bumps, so
/// reconnecting to the same channel (after Twitch refused its chat for a
/// ban or timeout) reads as a change to the supervisor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinedChannel {
    pub channel: Channel,
    pub join: u64,
}

impl ChannelState {
    pub fn new() -> (Self, watch::Receiver<ChannelSelection>) {
        Self::with_helix_base(HELIX_BASE)
    }

    pub fn with_helix_base(
        helix_base: impl Into<String>,
    ) -> (Self, watch::Receiver<ChannelSelection>) {
        let (tx, rx) = watch::channel(ChannelSelection::default());
        (
            Self {
                tx,
                helix_base: helix_base.into(),
                followers: FollowerCache::default(),
                followed: FollowedCache::default(),
            },
            rx,
        )
    }

    /// The channel the window shows.
    pub fn current(&self) -> Option<Channel> {
        self.tx.borrow().focused.clone()
    }

    pub fn joined(&self) -> Vec<Channel> {
        self.tx
            .borrow()
            .joined
            .iter()
            .map(|j| j.channel.clone())
            .collect()
    }

    pub fn helix_base(&self) -> &str {
        &self.helix_base
    }

    /// Joins `channel` if it is not open yet and makes it the focused one.
    pub fn join(&self, channel: Channel) {
        self.tx.send_if_modified(|sel| {
            let mut changed = false;
            if !sel.joined.iter().any(|j| j.channel.id == channel.id) {
                sel.joined.push(JoinedChannel {
                    channel: channel.clone(),
                    join: 0,
                });
                changed = true;
            }
            if sel.focused.as_ref() != Some(&channel) {
                sel.focused = Some(channel);
                changed = true;
            }
            changed
        });
    }

    /// Leaves a channel. If it was focused, the nearest remaining tab takes
    /// over, or nothing when it was the last one.
    pub fn leave(&self, channel_id: &str) {
        self.tx.send_if_modified(|sel| {
            let Some(pos) = sel.joined.iter().position(|j| j.channel.id == channel_id) else {
                return false;
            };
            sel.joined.remove(pos);
            if sel.focused.as_ref().is_some_and(|c| c.id == channel_id) {
                sel.focused = sel
                    .joined
                    .get(pos)
                    .or_else(|| sel.joined.last())
                    .map(|j| j.channel.clone());
            }
            true
        });
    }

    /// Shows an already joined channel. Returns false for an unknown id.
    pub fn focus(&self, channel_id: &str) -> bool {
        let mut known = false;
        self.tx.send_if_modified(|sel| {
            let Some(j) = sel.joined.iter().find(|j| j.channel.id == channel_id) else {
                return false;
            };
            known = true;
            if sel.focused.as_ref() == Some(&j.channel) {
                return false;
            }
            sel.focused = Some(j.channel.clone());
            true
        });
        known
    }

    /// Asks the supervisor to leave and rejoin one channel.
    pub fn rejoin(&self, channel_id: &str) {
        self.tx.send_if_modified(|sel| {
            match sel.joined.iter_mut().find(|j| j.channel.id == channel_id) {
                Some(j) => {
                    j.join += 1;
                    true
                }
                None => false,
            }
        });
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChannelError {
    NotLoggedIn {
        message: String,
    },
    InvalidLogin,
    NotFound {
        login: String,
    },
    Auth {
        message: String,
    },
    Http {
        message: String,
    },
    Helix {
        status: u16,
        message: String,
    },
    /// A chat setting value outside what Twitch accepts.
    InvalidSetting {
        message: String,
    },
}

impl From<AuthError> for ChannelError {
    fn from(err: AuthError) -> Self {
        match err {
            AuthError::NoTokens | AuthError::RefreshTokenInvalid => Self::NotLoggedIn {
                message: err.to_string(),
            },
            other => Self::Auth {
                message: other.to_string(),
            },
        }
    }
}

impl From<reqwest::Error> for ChannelError {
    fn from(err: reqwest::Error) -> Self {
        Self::Http {
            message: err.to_string(),
        }
    }
}

/// Twitch logins are 1-25 characters of `[a-z0-9_]`. Accepts a leading
/// `@` and surrounding whitespace since users paste handles in both forms.
pub fn normalize_login(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_start_matches('@').to_ascii_lowercase();
    let valid = (1..=25).contains(&trimmed.len())
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    valid.then_some(trimmed)
}

#[derive(Deserialize)]
struct UsersResponse {
    data: Vec<HelixUser>,
}

#[derive(Deserialize)]
struct HelixUser {
    id: String,
    login: String,
    display_name: String,
    #[serde(default)]
    profile_image_url: String,
}

pub async fn resolve_login(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    login: &str,
) -> Result<Channel, ChannelError> {
    let resp = http
        .get(format!("{helix_base}/users"))
        .query(&[("login", login)])
        .header("Client-Id", TWITCH_CLIENT_ID)
        .bearer_auth(access_token)
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
    let body: UsersResponse = resp.json().await?;
    let user = body
        .data
        .into_iter()
        .next()
        .ok_or_else(|| ChannelError::NotFound {
            login: login.to_owned(),
        })?;
    Ok(Channel {
        id: user.id,
        login: user.login,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url,
    })
}

/// Opens a channel as a tab and shows it.
#[tauri::command]
pub async fn twitch_join_channel(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    login: String,
) -> Result<Channel, ChannelError> {
    let login = normalize_login(&login).ok_or(ChannelError::InvalidLogin)?;
    let tokens = auth.manager.load_or_refresh().await?;
    let channel = resolve_login(
        auth.manager.http_client(),
        &channels.helix_base,
        &tokens.access_token,
        &login,
    )
    .await?;
    channels.join(channel.clone());
    Ok(channel)
}

#[tauri::command]
pub fn twitch_leave_channel(channels: State<'_, ChannelState>, channel_id: String) {
    channels.leave(&channel_id);
}

#[tauri::command]
pub fn twitch_focus_channel(channels: State<'_, ChannelState>, channel_id: String) -> bool {
    channels.focus(&channel_id)
}

/// Reconnects one channel's chat. The feed offers this after Twitch refused
/// the chat for a ban or timeout, since Twitch never says when a timeout
/// ends.
#[tauri::command]
pub fn twitch_rejoin_channel(channels: State<'_, ChannelState>, channel_id: String) {
    channels.rejoin(&channel_id);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelSearchResult {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub profile_image_url: String,
    pub is_live: bool,
    pub game_name: String,
    pub title: String,
    /// Current viewers, filled for live channels.
    pub viewer_count: Option<u64>,
    /// Follower total, filled for the candidates that were ranked.
    pub followers: Option<u64>,
    /// The signed-in user follows this channel.
    pub followed: bool,
}

#[derive(Deserialize)]
struct SearchResponse {
    data: Vec<HelixSearchChannel>,
}

#[derive(Deserialize)]
struct HelixSearchChannel {
    id: String,
    broadcaster_login: String,
    display_name: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    is_live: bool,
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    title: String,
}

/// Candidates pulled per Helix search call (the API maximum).
const SEARCH_FETCH: &str = "100";
/// Rows returned to the picker.
pub const SEARCH_RESULTS: usize = 10;
/// Candidates enriched with follower totals per search. Each is one Helix
/// call; they all run at once so the search costs one extra round trip.
/// Results are cached per session.
const FOLLOWER_LOOKUPS: usize = 24;

/// Follower totals by broadcaster id, filled lazily by searches.
pub type FollowerCache = Mutex<HashMap<String, u64>>;

/// How long the signed-in user's follow list is trusted before refetching.
const FOLLOWED_TTL: Duration = Duration::from_secs(10 * 60);
/// Pages of 100 fetched at most for the follow list.
const FOLLOWED_PAGES: usize = 10;

struct FollowedSnapshot {
    fetched_at: Instant,
    ids: Arc<HashSet<String>>,
}

/// Broadcaster ids the signed-in user follows, refreshed every
/// [`FOLLOWED_TTL`]. A failed fetch (typically a token without
/// `user:read:follows`) is cached as empty so a search never pays for the
/// same failure twice in a row.
#[derive(Default)]
pub struct FollowedCache(Mutex<Option<FollowedSnapshot>>);

impl FollowedCache {
    fn fresh(&self) -> Option<Arc<HashSet<String>>> {
        let guard = self.0.lock().expect("followed cache poisoned");
        guard
            .as_ref()
            .filter(|s| s.fetched_at.elapsed() < FOLLOWED_TTL)
            .map(|s| s.ids.clone())
    }

    fn store(&self, ids: HashSet<String>) -> Arc<HashSet<String>> {
        let ids = Arc::new(ids);
        *self.0.lock().expect("followed cache poisoned") = Some(FollowedSnapshot {
            fetched_at: Instant::now(),
            ids: ids.clone(),
        });
        ids
    }
}

#[derive(Deserialize)]
struct FollowedResponse {
    data: Vec<FollowedChannel>,
    #[serde(default)]
    pagination: Pagination,
}

#[derive(Deserialize)]
struct FollowedChannel {
    broadcaster_id: String,
}

pub async fn fetch_followed_ids(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    user_id: &str,
) -> Result<HashSet<String>, ChannelError> {
    let url = format!("{helix_base}/channels/followed");
    let mut out = HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..FOLLOWED_PAGES {
        let mut query = vec![("user_id", user_id), ("first", "100")];
        if let Some(c) = cursor.as_deref() {
            query.push(("after", c));
        }
        let page: FollowedResponse = helix_get(http, url.clone(), &query, access_token).await?;
        out.extend(page.data.into_iter().map(|c| c.broadcaster_id));
        match page.pagination.cursor {
            Some(next) if !next.is_empty() => cursor = Some(next),
            _ => break,
        }
    }
    Ok(out)
}

/// Cached follow list, fetched when stale. Errors are logged and yield an
/// empty set so search keeps working for tokens without the scope.
pub async fn followed_ids(
    cache: &FollowedCache,
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    user_id: &str,
) -> Arc<HashSet<String>> {
    if let Some(ids) = cache.fresh() {
        return ids;
    }
    let ids = match fetch_followed_ids(http, helix_base, access_token, user_id).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!(error = ?e, "follow list lookup failed; ranking without it");
            HashSet::new()
        }
    };
    cache.store(ids)
}

#[derive(Deserialize)]
struct StreamsLiteResponse {
    data: Vec<StreamLite>,
}

#[derive(Deserialize)]
struct StreamLite {
    user_id: String,
    #[serde(default)]
    viewer_count: u64,
}

#[derive(Deserialize)]
struct FollowersResponse {
    #[serde(default)]
    total: u64,
}

fn into_result(c: HelixSearchChannel) -> ChannelSearchResult {
    ChannelSearchResult {
        id: c.id,
        login: c.broadcaster_login,
        display_name: c.display_name,
        profile_image_url: c.thumbnail_url,
        is_live: c.is_live,
        game_name: c.game_name,
        title: c.title,
        viewer_count: None,
        followers: None,
        followed: false,
    }
}

/// Merges the two Helix result sets (name match and live-only match) into
/// one list keyed by id. Live-only hits mark a channel live even when the
/// name search returned it as offline.
fn merge_candidates(
    name_hits: Vec<HelixSearchChannel>,
    live_hits: Vec<HelixSearchChannel>,
) -> Vec<ChannelSearchResult> {
    let mut out: Vec<ChannelSearchResult> = Vec::with_capacity(name_hits.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for hit in name_hits.into_iter().chain(live_hits) {
        if let Some(&i) = index.get(&hit.id) {
            out[i].is_live |= hit.is_live;
            continue;
        }
        index.insert(hit.id.clone(), out.len());
        out.push(into_result(hit));
    }
    out
}

/// How likely a candidate is what the person meant, before any follower
/// data exists: exact login, then channels they follow, then names that
/// start with the query, then the rest of Helix's fuzzy matches. Decides
/// which candidates get the bounded follower lookups.
fn candidate_priority(c: &ChannelSearchResult, q: &str) -> u8 {
    if c.login == q {
        0
    } else if c.followed {
        1
    } else if c.login.starts_with(q) || c.display_name.to_lowercase().starts_with(q) {
        2
    } else {
        3
    }
}

/// Orders candidates the way a person expects: an exact login match first,
/// then channels they follow, then by size (follower total), with live
/// state and viewers only breaking ties. Helix itself returns matches
/// unranked, which buries big channels past the first page for short
/// queries.
fn rank_results(mut candidates: Vec<ChannelSearchResult>, query: &str) -> Vec<ChannelSearchResult> {
    let q = query.to_ascii_lowercase();
    candidates.sort_by(|a, b| {
        let exact = |c: &ChannelSearchResult| c.login == q;
        exact(b)
            .cmp(&exact(a))
            .then(b.followed.cmp(&a.followed))
            .then(b.followers.cmp(&a.followers))
            .then(b.is_live.cmp(&a.is_live))
            .then(b.viewer_count.cmp(&a.viewer_count))
    });
    candidates.truncate(SEARCH_RESULTS);
    candidates
}

async fn follower_total(
    http: reqwest::Client,
    helix_base: String,
    access_token: String,
    id: String,
) -> (String, Option<u64>) {
    let query = [("broadcaster_id", id.as_str()), ("first", "1")];
    let total = helix_get::<FollowersResponse>(
        &http,
        format!("{helix_base}/channels/followers"),
        &query,
        &access_token,
    )
    .await
    .map(|r| r.total);
    if let Err(e) = &total {
        tracing::warn!(broadcaster = %id, error = ?e, "follower total lookup failed");
    }
    (id, total.ok())
}

/// Ranked channel search. Two Helix searches run concurrently (name match
/// and live-only), live hits are enriched with viewer counts in one
/// `GET /streams` call, and the most likely candidates with follower
/// totals, all in parallel. Helix only matches channels that streamed in
/// the last six months, so an exact login missing here can still resolve
/// through [`resolve_login`].
pub async fn search_channels(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    query: &str,
    cache: &FollowerCache,
    followed: &HashSet<String>,
) -> Result<Vec<ChannelSearchResult>, ChannelError> {
    let q = query.to_ascii_lowercase();
    let url = format!("{helix_base}/search/channels");
    let name_query = [("query", query), ("first", SEARCH_FETCH)];
    let live_query = [
        ("query", query),
        ("first", SEARCH_FETCH),
        ("live_only", "true"),
    ];
    let name_hits = helix_get::<SearchResponse>(http, url.clone(), &name_query, access_token);
    let live_hits = helix_get::<SearchResponse>(http, url, &live_query, access_token);
    let (name_hits, live_hits) = tokio::try_join!(name_hits, live_hits)?;
    let mut candidates = merge_candidates(name_hits.data, live_hits.data);
    for c in candidates.iter_mut() {
        c.followed = followed.contains(&c.id);
    }
    candidates.sort_by_key(|c| candidate_priority(c, &q));

    let live_ids: Vec<(&str, &str)> = candidates
        .iter()
        .filter(|c| c.is_live)
        .map(|c| ("user_id", c.id.as_str()))
        .collect();
    if !live_ids.is_empty() {
        let streams = helix_get::<StreamsLiteResponse>(
            http,
            format!("{helix_base}/streams"),
            &live_ids,
            access_token,
        )
        .await?;
        let viewers: HashMap<String, u64> = streams
            .data
            .into_iter()
            .map(|s| (s.user_id, s.viewer_count))
            .collect();
        for c in candidates.iter_mut().filter(|c| c.is_live) {
            c.viewer_count = viewers.get(&c.id).copied();
        }
    }

    let mut misses: Vec<String> = Vec::new();
    {
        let cached = cache.lock().expect("follower cache poisoned");
        for c in candidates.iter_mut().take(FOLLOWER_LOOKUPS) {
            match cached.get(&c.id) {
                Some(total) => c.followers = Some(*total),
                None => misses.push(c.id.clone()),
            }
        }
    }
    if !misses.is_empty() {
        let fetched: Vec<(String, Option<u64>)> = stream::iter(misses)
            .map(|id| {
                follower_total(
                    http.clone(),
                    helix_base.to_owned(),
                    access_token.to_owned(),
                    id,
                )
            })
            .buffer_unordered(FOLLOWER_LOOKUPS)
            .collect()
            .await;
        let mut cached = cache.lock().expect("follower cache poisoned");
        for (id, total) in fetched {
            if let Some(total) = total {
                cached.insert(id.clone(), total);
                if let Some(c) = candidates.iter_mut().find(|c| c.id == id) {
                    c.followers = Some(total);
                }
            }
        }
    }

    Ok(rank_results(candidates, query))
}

#[tauri::command]
pub async fn twitch_search_channels(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    query: String,
) -> Result<Vec<ChannelSearchResult>, ChannelError> {
    let query = query.trim().trim_start_matches('@');
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let tokens = auth.manager.load_or_refresh().await?;
    let http = auth.manager.http_client();
    let followed = followed_ids(
        &channels.followed,
        http,
        &channels.helix_base,
        &tokens.access_token,
        &tokens.user_id,
    )
    .await;
    search_channels(
        http,
        &channels.helix_base,
        &tokens.access_token,
        query,
        &channels.followers,
        &followed,
    )
    .await
}

#[tauri::command]
pub fn twitch_get_channel(channels: State<'_, ChannelState>) -> Option<Channel> {
    channels.current()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamInfo {
    pub is_live: bool,
    pub title: String,
    pub game_name: String,
    /// Present only while live.
    pub viewer_count: Option<u64>,
    /// RFC 3339 start time, present only while live.
    pub started_at: Option<String>,
}

#[derive(Deserialize)]
struct StreamsResponse {
    data: Vec<HelixStream>,
}

#[derive(Deserialize)]
struct HelixStream {
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    viewer_count: u64,
    #[serde(default)]
    started_at: String,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    data: Vec<HelixChannelInfo>,
}

#[derive(Deserialize)]
struct HelixChannelInfo {
    #[serde(default)]
    game_name: String,
    #[serde(default)]
    title: String,
}

pub(crate) async fn helix_get<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: String,
    query: &[(&str, &str)],
    access_token: &str,
) -> Result<T, ChannelError> {
    let resp = http
        .get(url)
        .query(query)
        .header("Client-Id", TWITCH_CLIENT_ID)
        .bearer_auth(access_token)
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
    Ok(resp.json().await?)
}

/// Live state from Helix `GET /streams` plus the channel's last title and
/// category from `GET /channels`, so an offline channel still shows what
/// it last streamed. The two requests run concurrently.
pub async fn fetch_stream_info(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<StreamInfo, ChannelError> {
    let stream_query = [("user_id", broadcaster_id)];
    let channel_query = [("broadcaster_id", broadcaster_id)];
    let streams = helix_get::<StreamsResponse>(
        http,
        format!("{helix_base}/streams"),
        &stream_query,
        access_token,
    );
    let channels = helix_get::<ChannelsResponse>(
        http,
        format!("{helix_base}/channels"),
        &channel_query,
        access_token,
    );
    let (streams, channels) = tokio::try_join!(streams, channels)?;

    if let Some(live) = streams.data.into_iter().next() {
        return Ok(StreamInfo {
            is_live: true,
            title: live.title,
            game_name: live.game_name,
            viewer_count: Some(live.viewer_count),
            started_at: Some(live.started_at),
        });
    }
    let info = channels.data.into_iter().next();
    Ok(StreamInfo {
        is_live: false,
        title: info.as_ref().map(|c| c.title.clone()).unwrap_or_default(),
        game_name: info.map(|c| c.game_name).unwrap_or_default(),
        viewer_count: None,
        started_at: None,
    })
}

#[tauri::command]
pub async fn twitch_get_stream_info(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    channel_id: String,
) -> Result<Option<StreamInfo>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_stream_info(
        auth.manager.http_client(),
        &channels.helix_base,
        &tokens.access_token,
        &channel_id,
    )
    .await
    .map(Some)
}

/// Channels where the signed-in user holds the moderator role, from Helix
/// `GET /moderation/channels`. The UI uses this to show moderation controls
/// only where they will work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModeratedChannel {
    pub broadcaster_id: String,
    pub broadcaster_login: String,
    pub broadcaster_name: String,
}

#[derive(Deserialize)]
struct ModeratedResponse {
    data: Vec<ModeratedChannel>,
    #[serde(default)]
    pagination: Pagination,
}

#[derive(Deserialize, Default)]
struct Pagination {
    #[serde(default)]
    cursor: Option<String>,
}

/// Pages fetched at most; 100 channels each.
const MODERATED_PAGES: usize = 10;

pub async fn fetch_moderated_channels(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    user_id: &str,
) -> Result<Vec<ModeratedChannel>, ChannelError> {
    let url = format!("{helix_base}/moderation/channels");
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MODERATED_PAGES {
        let mut query = vec![("user_id", user_id), ("first", "100")];
        if let Some(c) = cursor.as_deref() {
            query.push(("after", c));
        }
        let page: ModeratedResponse = helix_get(http, url.clone(), &query, access_token).await?;
        out.extend(page.data);
        match page.pagination.cursor {
            Some(next) if !next.is_empty() => cursor = Some(next),
            _ => break,
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn twitch_moderated_channels(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<Vec<ModeratedChannel>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_moderated_channels(
        auth.manager.http_client(),
        &channels.helix_base,
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

/// Public profile fields from Helix `GET /users`, for the account insight
/// shown on chatters: how old the account is and what it looks like.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub login: String,
    pub display_name: String,
    #[serde(default)]
    pub profile_image_url: String,
    #[serde(default)]
    pub description: String,
    /// RFC 3339 account creation time.
    #[serde(default)]
    pub created_at: String,
}

#[derive(Deserialize)]
struct UsersInfoResponse {
    data: Vec<UserInfo>,
}

/// Ids per Helix `GET /users` call (the API maximum).
const USERS_PER_REQUEST: usize = 100;

pub async fn fetch_users_info(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    ids: &[String],
) -> Result<Vec<UserInfo>, ChannelError> {
    let url = format!("{helix_base}/users");
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(USERS_PER_REQUEST) {
        let query: Vec<(&str, &str)> = chunk.iter().map(|id| ("id", id.as_str())).collect();
        let page: UsersInfoResponse = helix_get(http, url.clone(), &query, access_token).await?;
        out.extend(page.data);
    }
    Ok(out)
}

#[tauri::command]
pub async fn twitch_users_info(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    ids: Vec<String>,
) -> Result<Vec<UserInfo>, ChannelError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_users_info(
        auth.manager.http_client(),
        &channels.helix_base,
        &tokens.access_token,
        &ids,
    )
    .await
}

/// Resolves any Twitch login to its id and names, for slash commands that
/// name a user who has not spoken in the session.
#[tauri::command]
pub async fn twitch_lookup_user(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    login: String,
) -> Result<Channel, ChannelError> {
    let login = normalize_login(&login).ok_or(ChannelError::InvalidLogin)?;
    let tokens = auth.manager.load_or_refresh().await?;
    resolve_login(
        auth.manager.http_client(),
        &channels.helix_base,
        &tokens.access_token,
        &login,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    #[test]
    fn normalize_login_accepts_handles_and_case() {
        assert_eq!(normalize_login(" @XQC "), Some("xqc".into()));
        assert_eq!(normalize_login("some_user_1"), Some("some_user_1".into()));
    }

    #[test]
    fn normalize_login_rejects_bad_input() {
        assert_eq!(normalize_login(""), None);
        assert_eq!(normalize_login("@"), None);
        assert_eq!(normalize_login("has space"), None);
        assert_eq!(normalize_login("twitch.tv/xqc"), None);
        assert_eq!(normalize_login(&"a".repeat(26)), None);
    }

    fn chan(id: &str) -> Channel {
        Channel {
            id: id.into(),
            login: id.into(),
            display_name: id.to_uppercase(),
            profile_image_url: String::new(),
        }
    }

    #[test]
    fn join_is_idempotent_for_an_open_focused_channel() {
        let (state, mut rx) = ChannelState::new();
        state.join(chan("1"));
        assert!(rx.has_changed().unwrap());
        drop(rx.borrow_and_update());
        state.join(chan("1"));
        assert!(!rx.has_changed().unwrap());
        assert_eq!(state.current(), Some(chan("1")));
        assert_eq!(state.joined(), vec![chan("1")]);
    }

    #[test]
    fn join_keeps_earlier_tabs_and_focuses_the_new_one() {
        let (state, mut rx) = ChannelState::new();
        state.join(chan("1"));
        state.join(chan("2"));
        assert_eq!(state.joined(), vec![chan("1"), chan("2")]);
        assert_eq!(state.current(), Some(chan("2")));
        drop(rx.borrow_and_update());
        assert!(state.focus("1"));
        assert!(rx.has_changed().unwrap());
        assert_eq!(state.current(), Some(chan("1")));
        assert_eq!(state.joined().len(), 2);
        drop(rx.borrow_and_update());
        assert!(!state.focus("9"));
        assert!(!rx.has_changed().unwrap());
    }

    #[test]
    fn leave_moves_focus_to_the_neighbour() {
        let (state, _rx) = ChannelState::new();
        state.join(chan("1"));
        state.join(chan("2"));
        state.join(chan("3"));
        state.focus("2");
        state.leave("2");
        assert_eq!(state.joined(), vec![chan("1"), chan("3")]);
        assert_eq!(state.current(), Some(chan("3")));
        state.leave("3");
        assert_eq!(state.current(), Some(chan("1")));
        state.leave("1");
        assert_eq!(state.current(), None);
        assert!(state.joined().is_empty());
    }

    #[test]
    fn leave_of_an_unfocused_tab_keeps_focus() {
        let (state, mut rx) = ChannelState::new();
        state.join(chan("1"));
        state.join(chan("2"));
        drop(rx.borrow_and_update());
        state.leave("1");
        assert!(rx.has_changed().unwrap());
        assert_eq!(state.current(), Some(chan("2")));
        drop(rx.borrow_and_update());
        state.leave("unknown");
        assert!(!rx.has_changed().unwrap());
    }

    #[test]
    fn rejoin_bumps_only_that_channel() {
        let (state, mut rx) = ChannelState::new();
        state.join(chan("1"));
        state.join(chan("2"));
        drop(rx.borrow_and_update());
        state.rejoin("1");
        assert!(rx.has_changed().unwrap());
        let sel = rx.borrow_and_update().clone();
        assert_eq!(sel.joined[0].join, 1);
        assert_eq!(sel.joined[1].join, 0);
        assert_eq!(sel.focused, Some(chan("2")));
        state.rejoin("nope");
        assert!(!rx.has_changed().unwrap());
    }

    #[tokio::test]
    async fn resolve_login_parses_helix_user() {
        let server = MockServer::start_async().await;
        let m = server.mock(|when, then| {
            when.method(GET)
                .path("/users")
                .query_param("login", "xqc")
                .header("Client-Id", TWITCH_CLIENT_ID)
                .header("Authorization", "Bearer tok");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "id": "71092938",
                    "login": "xqc",
                    "display_name": "xQc",
                    "profile_image_url": "https://img/x.png"
                }]
            }));
        });
        let http = reqwest::Client::new();
        let c = resolve_login(&http, &server.base_url(), "tok", "xqc")
            .await
            .unwrap();
        m.assert();
        assert_eq!(c.id, "71092938");
        assert_eq!(c.display_name, "xQc");
        assert_eq!(c.profile_image_url, "https://img/x.png");
    }

    #[tokio::test]
    async fn resolve_login_maps_empty_data_to_not_found() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/users");
            then.status(200)
                .json_body(serde_json::json!({ "data": [] }));
        });
        let http = reqwest::Client::new();
        let err = resolve_login(&http, &server.base_url(), "tok", "nobody")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::NotFound { login } if login == "nobody"));
    }

    #[tokio::test]
    async fn resolve_login_surfaces_helix_status() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/users");
            then.status(401)
                .body("{\"message\":\"Invalid OAuth token\"}");
        });
        let http = reqwest::Client::new();
        let err = resolve_login(&http, &server.base_url(), "tok", "xqc")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
    }

    fn hit(id: &str, login: &str, live: bool) -> HelixSearchChannel {
        HelixSearchChannel {
            id: id.into(),
            broadcaster_login: login.into(),
            display_name: login.to_uppercase(),
            thumbnail_url: String::new(),
            is_live: live,
            game_name: String::new(),
            title: String::new(),
        }
    }

    #[test]
    fn merge_marks_live_from_the_live_only_search() {
        let merged = merge_candidates(
            vec![hit("1", "a", false), hit("2", "b", false)],
            vec![hit("2", "b", true), hit("3", "c", true)],
        );
        let flags: Vec<(&str, bool)> = merged.iter().map(|c| (c.id.as_str(), c.is_live)).collect();
        assert_eq!(flags, vec![("1", false), ("2", true), ("3", true)]);
    }

    #[test]
    fn rank_puts_exact_then_followed_then_size_with_live_as_tiebreak() {
        let mut big = into_result(hit("1", "jynx_big", false));
        big.followers = Some(5_000_000);
        let mut small = into_result(hit("2", "jynxa", false));
        small.followers = Some(10);
        small.followed = true;
        let mut live_small = into_result(hit("3", "jynlive", true));
        live_small.viewer_count = Some(50);
        let mut live_big = into_result(hit("4", "jynliveb", true));
        live_big.viewer_count = Some(9000);
        let exact = into_result(hit("5", "jyn", false));
        let ranked = rank_results(vec![live_small, big, live_big, exact, small], "JYN");
        let logins: Vec<&str> = ranked.iter().map(|c| c.login.as_str()).collect();
        assert_eq!(
            logins,
            vec!["jyn", "jynxa", "jynx_big", "jynliveb", "jynlive"]
        );
    }

    #[test]
    fn candidate_priority_prefers_exact_followed_then_prefix() {
        let exact = into_result(hit("1", "jyn", false));
        let mut followed = into_result(hit("2", "zzz_jyn", false));
        followed.followed = true;
        let prefix = into_result(hit("3", "jynxzi", false));
        let fuzzy = into_result(hit("4", "notjyn", false));
        assert_eq!(candidate_priority(&exact, "jyn"), 0);
        assert_eq!(candidate_priority(&followed, "jyn"), 1);
        assert_eq!(candidate_priority(&prefix, "jyn"), 2);
        assert_eq!(candidate_priority(&fuzzy, "jyn"), 3);
    }

    #[tokio::test]
    async fn search_channels_enriches_and_ranks() {
        let server = MockServer::start_async().await;
        let search = server.mock(|when, then| {
            when.method(GET)
                .path("/search/channels")
                .query_param("query", "jyn")
                .query_param("first", "100")
                .header("Client-Id", TWITCH_CLIENT_ID)
                .header("Authorization", "Bearer tok");
            then.status(200).json_body(serde_json::json!({
                "data": [
                    {"id": "1", "broadcaster_login": "jynsmall", "display_name": "jynsmall", "is_live": false, "thumbnail_url": "", "game_name": "", "title": ""},
                    {"id": "2", "broadcaster_login": "jynxzi", "display_name": "Jynxzi", "is_live": true, "thumbnail_url": "https://img/j.png", "game_name": "R6", "title": "live"}
                ],
                "pagination": {}
            }));
        });
        let streams = server.mock(|when, then| {
            when.method(GET)
                .path("/streams")
                .query_param("user_id", "2");
            then.status(200).json_body(serde_json::json!({
                "data": [{"user_id": "2", "viewer_count": 42000}]
            }));
        });
        let followers = server.mock(|when, then| {
            when.method(GET)
                .path("/channels/followers")
                .query_param("broadcaster_id", "1");
            then.status(200)
                .json_body(serde_json::json!({ "total": 7, "data": [], "pagination": {} }));
        });
        let big = server.mock(|when, then| {
            when.method(GET)
                .path("/channels/followers")
                .query_param("broadcaster_id", "2");
            then.status(200)
                .json_body(serde_json::json!({ "total": 5_000_000, "data": [], "pagination": {} }));
        });
        let http = reqwest::Client::new();
        let cache = FollowerCache::default();
        let none = HashSet::new();
        let got = search_channels(&http, &server.base_url(), "tok", "jyn", &cache, &none)
            .await
            .unwrap();
        assert_eq!(search.calls(), 2);
        assert_eq!(streams.calls(), 1);
        assert_eq!(followers.calls(), 1);
        assert_eq!(big.calls(), 1);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].login, "jynxzi");
        assert_eq!(got[0].viewer_count, Some(42000));
        assert_eq!(got[0].followers, Some(5_000_000));
        assert_eq!(got[1].followers, Some(7));

        // A followed channel outranks a bigger one; follower totals come
        // from the cache the second time round.
        let followed: HashSet<String> = ["1".to_string()].into_iter().collect();
        let got = search_channels(&http, &server.base_url(), "tok", "jyn", &cache, &followed)
            .await
            .unwrap();
        assert_eq!(followers.calls(), 1);
        assert_eq!(big.calls(), 1);
        assert_eq!(got[0].login, "jynsmall");
        assert!(got[0].followed);
    }

    #[tokio::test]
    async fn followed_ids_pages_and_caches_failures_as_empty() {
        let server = MockServer::start_async().await;
        let first = server.mock(|when, then| {
            when.method(GET)
                .path("/channels/followed")
                .query_param("user_id", "12345")
                .query_param_missing("after");
            then.status(200).json_body(serde_json::json!({
                "data": [{"broadcaster_id": "1", "broadcaster_login": "a", "broadcaster_name": "A", "followed_at": "2020-01-01T00:00:00Z"}],
                "pagination": {"cursor": "c2"}, "total": 2
            }));
        });
        let second = server.mock(|when, then| {
            when.method(GET).path("/channels/followed").query_param("after", "c2");
            then.status(200).json_body(serde_json::json!({
                "data": [{"broadcaster_id": "2", "broadcaster_login": "b", "broadcaster_name": "B", "followed_at": "2020-01-01T00:00:00Z"}],
                "pagination": {}, "total": 2
            }));
        });
        let http = reqwest::Client::new();
        let cache = FollowedCache::default();
        let ids = followed_ids(&cache, &http, &server.base_url(), "tok", "12345").await;
        assert_eq!(first.calls(), 1);
        assert_eq!(second.calls(), 1);
        assert!(ids.contains("1") && ids.contains("2"));
        followed_ids(&cache, &http, &server.base_url(), "tok", "12345").await;
        assert_eq!(first.calls(), 1);

        let denied = MockServer::start_async().await;
        let scope = denied.mock(|when, then| {
            when.method(GET).path("/channels/followed");
            then.status(401).body("Missing scope: user:read:follows");
        });
        let cache = FollowedCache::default();
        assert!(followed_ids(&cache, &http, &denied.base_url(), "tok", "1")
            .await
            .is_empty());
        assert!(followed_ids(&cache, &http, &denied.base_url(), "tok", "1")
            .await
            .is_empty());
        assert_eq!(scope.calls(), 1);
    }

    #[tokio::test]
    async fn search_channels_surfaces_helix_status() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/search/channels");
            then.status(429).body("rate limited");
        });
        let http = reqwest::Client::new();
        let err = search_channels(
            &http,
            &server.base_url(),
            "tok",
            "x",
            &FollowerCache::default(),
            &HashSet::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 429, .. }));
    }

    #[tokio::test]
    async fn stream_info_live_uses_streams_data() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/streams")
                .query_param("user_id", "1");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "user_id": "1",
                    "type": "live",
                    "game_name": "Just Chatting",
                    "title": "hello",
                    "viewer_count": 1234,
                    "started_at": "2026-10-24T20:00:00Z"
                }]
            }));
        });
        server.mock(|when, then| {
            when.method(GET)
                .path("/channels")
                .query_param("broadcaster_id", "1");
            then.status(200).json_body(serde_json::json!({
                "data": [{ "game_name": "Old", "title": "old title" }]
            }));
        });
        let http = reqwest::Client::new();
        let info = fetch_stream_info(&http, &server.base_url(), "tok", "1")
            .await
            .unwrap();
        assert_eq!(
            info,
            StreamInfo {
                is_live: true,
                title: "hello".into(),
                game_name: "Just Chatting".into(),
                viewer_count: Some(1234),
                started_at: Some("2026-10-24T20:00:00Z".into()),
            }
        );
    }

    #[tokio::test]
    async fn stream_info_offline_falls_back_to_channel() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/streams");
            then.status(200)
                .json_body(serde_json::json!({ "data": [] }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/channels");
            then.status(200).json_body(serde_json::json!({
                "data": [{ "game_name": "Minecraft", "title": "last time" }]
            }));
        });
        let http = reqwest::Client::new();
        let info = fetch_stream_info(&http, &server.base_url(), "tok", "1")
            .await
            .unwrap();
        assert_eq!(
            info,
            StreamInfo {
                is_live: false,
                title: "last time".into(),
                game_name: "Minecraft".into(),
                viewer_count: None,
                started_at: None,
            }
        );
    }

    #[tokio::test]
    async fn moderated_channels_follows_pagination() {
        let server = MockServer::start_async().await;
        let first = server.mock(|when, then| {
            when.method(GET)
                .path("/moderation/channels")
                .query_param("user_id", "12345")
                .query_param("first", "100")
                .query_param_missing("after")
                .header("Authorization", "Bearer tok");
            then.status(200).json_body(serde_json::json!({
                "data": [{"broadcaster_id": "1", "broadcaster_login": "a", "broadcaster_name": "A"}],
                "pagination": {"cursor": "c2"}
            }));
        });
        let second = server.mock(|when, then| {
            when.method(GET)
                .path("/moderation/channels")
                .query_param("after", "c2");
            then.status(200).json_body(serde_json::json!({
                "data": [{"broadcaster_id": "2", "broadcaster_login": "b", "broadcaster_name": "B"}],
                "pagination": {}
            }));
        });
        let http = reqwest::Client::new();
        let got = fetch_moderated_channels(&http, &server.base_url(), "tok", "12345")
            .await
            .unwrap();
        assert_eq!(first.calls(), 1);
        assert_eq!(second.calls(), 1);
        let ids: Vec<&str> = got.iter().map(|c| c.broadcaster_id.as_str()).collect();
        assert_eq!(ids, vec!["1", "2"]);
    }

    #[tokio::test]
    async fn users_info_chunks_ids_per_helix_limit() {
        let server = MockServer::start_async().await;
        let users = server.mock(|when, then| {
            when.method(GET)
                .path("/users")
                .header("Authorization", "Bearer tok");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "id": "1", "login": "a", "display_name": "A",
                    "profile_image_url": "https://img/a.png",
                    "description": "hi", "created_at": "2020-01-01T00:00:00Z",
                    "type": "", "broadcaster_type": "affiliate"
                }]
            }));
        });
        let ids: Vec<String> = (0..USERS_PER_REQUEST + 1).map(|i| i.to_string()).collect();
        let got = fetch_users_info(&reqwest::Client::new(), &server.base_url(), "tok", &ids)
            .await
            .unwrap();
        assert_eq!(users.calls(), 2);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].created_at, "2020-01-01T00:00:00Z");
        assert_eq!(got[0].description, "hi");
    }

    #[tokio::test]
    async fn moderated_channels_surfaces_missing_scope() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/moderation/channels");
            then.status(401)
                .body("Missing scope: user:read:moderated_channels");
        });
        let err = fetch_moderated_channels(&reqwest::Client::new(), &server.base_url(), "tok", "1")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
    }
}
