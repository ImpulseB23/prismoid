//! A chatter's subscription to a channel, from ivr.fi. Twitch's own API
//! only tells the broadcaster and their moderators, so for everyone else
//! the user card asks this community service, the one Chatterino uses.
//! The lookup sends both logins to it; the privacy page says so.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ttl_cache::TtlCache;
use crate::twitch_auth::AuthState;

const IVR_BASE: &str = "https://api.ivr.fi/v2";

/// Sub lookups by (user, channel) login. A failed lookup is not kept, so
/// the next card asks again.
pub struct SubAgeCache(TtlCache<(String, String), SubAge>);

impl Default for SubAgeCache {
    fn default() -> Self {
        Self(TtlCache::new(Duration::from_secs(5 * 60), 500))
    }
}

impl SubAgeCache {
    async fn lookup(
        &self,
        http: &reqwest::Client,
        base: &str,
        user: &str,
        channel: &str,
    ) -> Result<SubAge, String> {
        let key = (user.to_ascii_lowercase(), channel.to_ascii_lowercase());
        let (u, c) = key.clone();
        self.0
            .get_or_try_insert_with(
                key,
                || async move { fetch_subage(http, base, &u, &c).await },
            )
            .await
    }
}

/// What the card shows about `user`'s sub to the channel.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SubAge {
    /// The user chose to hide their sub status.
    pub hidden: bool,
    /// Subscribed now: `paid`, `gift` or `prime`.
    pub kind: Option<String>,
    /// `1`, `2` or `3` while subscribed.
    pub tier: Option<String>,
    /// Months subscribed in total, now or in the past.
    pub months: Option<u32>,
    /// Months in a row, while subscribed.
    pub streak: Option<u32>,
    pub followed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubAgeResponse {
    #[serde(default)]
    status_hidden: bool,
    followed_at: Option<String>,
    streak: Option<Months>,
    cumulative: Option<Months>,
    meta: Option<Meta>,
}

#[derive(Deserialize)]
struct Months {
    months: u32,
}

#[derive(Deserialize)]
struct Meta {
    #[serde(rename = "type")]
    kind: String,
    tier: String,
}

/// ivr.fi's own pattern for a login; anything else never reaches the URL.
fn valid_login(login: &str) -> bool {
    let mut chars = login.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && login.len() <= 25
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && login.len() > 1
}

pub async fn fetch_subage(
    http: &reqwest::Client,
    base: &str,
    user: &str,
    channel: &str,
) -> Result<SubAge, String> {
    if !valid_login(user) || !valid_login(channel) {
        return Err(format!("not a twitch login: {user} / {channel}"));
    }
    let resp = http
        .get(format!("{base}/twitch/subage/{user}/{channel}"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("ivr.fi answered {}", resp.status()));
    }
    let body: SubAgeResponse = resp.json().await.map_err(|e| e.to_string())?;
    let active = body.meta.is_some();
    Ok(SubAge {
        hidden: body.status_hidden,
        kind: body.meta.as_ref().map(|m| m.kind.clone()),
        tier: body.meta.map(|m| m.tier),
        months: body.cumulative.map(|c| c.months).filter(|m| *m > 0),
        streak: body.streak.map(|s| s.months).filter(|m| active && *m > 0),
        followed_at: body.followed_at,
    })
}

#[tauri::command]
pub async fn twitch_subage(
    auth: State<'_, AuthState>,
    cache: State<'_, SubAgeCache>,
    user: String,
    channel: String,
) -> Result<SubAge, String> {
    cache
        .lookup(auth.manager.http_client(), IVR_BASE, &user, &channel)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    async fn lookup(body: serde_json::Value) -> SubAge {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/twitch/subage/viewer/streamer");
            then.status(200).json_body(body);
        });
        fetch_subage(
            &reqwest::Client::new(),
            &server.base_url(),
            "viewer",
            "streamer",
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn reads_a_current_sub_with_its_streak() {
        let got = lookup(serde_json::json!({
            "statusHidden": false,
            "followedAt": "2020-04-25T10:00:00Z",
            "streak": { "months": 12 },
            "cumulative": { "months": 21 },
            "meta": { "type": "paid", "tier": "1", "endsAt": null }
        }))
        .await;
        assert_eq!(
            got,
            SubAge {
                hidden: false,
                kind: Some("paid".into()),
                tier: Some("1".into()),
                months: Some(21),
                streak: Some(12),
                followed_at: Some("2020-04-25T10:00:00Z".into()),
            }
        );
    }

    #[tokio::test]
    async fn reads_a_past_sub_and_a_hidden_one() {
        let past = lookup(serde_json::json!({
            "statusHidden": false,
            "followedAt": null,
            "streak": null,
            "cumulative": { "months": 77 },
            "meta": null
        }))
        .await;
        assert_eq!(past.months, Some(77));
        assert_eq!((past.kind, past.streak), (None, None));

        let hidden = lookup(serde_json::json!({ "statusHidden": true })).await;
        assert!(hidden.hidden);
        assert_eq!(hidden.months, None);
    }

    #[tokio::test]
    async fn refuses_odd_logins_and_reports_errors() {
        let http = reqwest::Client::new();
        assert!(fetch_subage(&http, "http://unused", "../x", "streamer")
            .await
            .is_err());
        assert!(!valid_login("a"));
        assert!(valid_login("xqc_2"));

        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET);
            then.status(503);
        });
        let err = fetch_subage(&http, &server.base_url(), "viewer", "streamer")
            .await
            .unwrap_err();
        assert!(err.contains("503"));
    }

    #[tokio::test]
    async fn repeat_lookups_come_from_the_cache_whatever_the_case() {
        let server = MockServer::start_async().await;
        let hit = server.mock(|when, then| {
            when.method(GET).path("/twitch/subage/viewer/streamer");
            then.status(200)
                .json_body(serde_json::json!({ "statusHidden": true }));
        });
        let cache = SubAgeCache::default();
        let http = reqwest::Client::new();
        for user in ["viewer", "Viewer"] {
            let got = cache
                .lookup(&http, &server.base_url(), user, "streamer")
                .await
                .unwrap();
            assert!(got.hidden);
        }
        hit.assert_calls(1);
    }
}
