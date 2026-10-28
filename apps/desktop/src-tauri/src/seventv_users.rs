//! Names for 7TV accounts, looked up when the UI needs one (who added a
//! channel emote). Uses the public v3 GraphQL `usersByID` query, which
//! takes up to 100 ids per call. Found users are cached for the session;
//! failures and unknown ids are not, so a later ask tries them again.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

pub const GQL_URL: &str = "https://7tv.io/v3/gql";
/// The most ids `usersByID` accepts in one call.
const IDS_PER_REQUEST: usize = 100;
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const QUERY: &str = "query($list:[ObjectID!]!){usersByID(list:$list){id username display_name}}";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SevenTvUser {
    pub id: String,
    pub login: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SevenTvError {
    Http { message: String },
    Api { status: u16, message: String },
    Gql { message: String },
}

impl From<reqwest::Error> for SevenTvError {
    fn from(err: reqwest::Error) -> Self {
        Self::Http {
            message: err.to_string(),
        }
    }
}

pub struct SevenTvUsers {
    http: reqwest::Client,
    url: String,
    cache: Mutex<HashMap<String, SevenTvUser>>,
}

impl SevenTvUsers {
    pub fn new(http: reqwest::Client) -> Self {
        Self::with_url(http, GQL_URL)
    }

    pub fn with_url(http: reqwest::Client, url: impl Into<String>) -> Self {
        Self {
            http,
            url: url.into(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The users behind `ids`, in no particular order. Ids 7TV does not know
    /// are left out. A failed batch fails the call, but batches that already
    /// came back stay cached.
    pub async fn get(&self, ids: &[String]) -> Result<Vec<SevenTvUser>, SevenTvError> {
        let mut out = Vec::new();
        let mut missing = Vec::new();
        {
            let cache = self.cache.lock().expect("7tv user cache poisoned");
            let mut seen = HashSet::new();
            for id in ids {
                if !seen.insert(id.as_str()) {
                    continue;
                }
                match cache.get(id) {
                    Some(user) => out.push(user.clone()),
                    None => missing.push(id.clone()),
                }
            }
        }
        for chunk in missing.chunks(IDS_PER_REQUEST) {
            let users = fetch(&self.http, &self.url, chunk).await?;
            let mut cache = self.cache.lock().expect("7tv user cache poisoned");
            for user in &users {
                cache.insert(user.id.clone(), user.clone());
            }
            out.extend(users);
        }
        Ok(out)
    }
}

#[derive(Deserialize)]
struct GqlResponse {
    data: Option<GqlData>,
    #[serde(default)]
    errors: Vec<GqlError>,
}

#[derive(Deserialize)]
struct GqlData {
    #[serde(rename = "usersByID")]
    users_by_id: Vec<GqlUser>,
}

#[derive(Deserialize)]
struct GqlUser {
    id: String,
    username: String,
    #[serde(default)]
    display_name: String,
}

#[derive(Deserialize)]
struct GqlError {
    message: String,
}

async fn fetch(
    http: &reqwest::Client,
    url: &str,
    ids: &[String],
) -> Result<Vec<SevenTvUser>, SevenTvError> {
    let resp = http
        .post(url)
        .json(&serde_json::json!({ "query": QUERY, "variables": { "list": ids } }))
        .timeout(FETCH_TIMEOUT)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let message = resp.text().await.unwrap_or_default();
        return Err(SevenTvError::Api {
            status: status.as_u16(),
            message,
        });
    }
    let body: GqlResponse = resp.json().await?;
    if let Some(err) = body.errors.into_iter().next() {
        return Err(SevenTvError::Gql {
            message: err.message,
        });
    }
    let users = body.data.map(|d| d.users_by_id).unwrap_or_default();
    Ok(users
        .into_iter()
        .map(|u| SevenTvUser {
            // 7TV leaves the display name blank on some accounts.
            display_name: if u.display_name.is_empty() {
                u.username.clone()
            } else {
                u.display_name
            },
            id: u.id,
            login: u.username,
        })
        .collect())
}

#[tauri::command]
pub async fn seventv_users(
    state: State<'_, SevenTvUsers>,
    ids: Vec<String>,
) -> Result<Vec<SevenTvUser>, SevenTvError> {
    state.get(&ids).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::Method::POST;
    use httpmock::MockServer;

    fn ids(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[tokio::test]
    async fn resolves_and_caches() {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/gql")
                .json_body_includes(r#"{"variables":{"list":["01FE","01FF","01GONE"]}}"#);
            then.status(200).json_body(serde_json::json!({
                "data": {"usersByID": [
                    {"id": "01FE", "username": "xqc", "display_name": "xQc"},
                    {"id": "01FF", "username": "victorleporc_", "display_name": ""}
                ]}
            }));
        });
        let users = SevenTvUsers::with_url(reqwest::Client::new(), server.url("/gql"));

        let mut got = users
            .get(&ids(&["01FE", "01FF", "01FE", "01GONE"]))
            .await
            .unwrap();
        got.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            got,
            vec![
                SevenTvUser {
                    id: "01FE".into(),
                    login: "xqc".into(),
                    display_name: "xQc".into()
                },
                SevenTvUser {
                    id: "01FF".into(),
                    login: "victorleporc_".into(),
                    display_name: "victorleporc_".into()
                },
            ]
        );
        mock.assert();

        let again = users.get(&ids(&["01FE", "01FF"])).await.unwrap();
        assert_eq!(again.len(), 2);
        assert_eq!(mock.calls(), 1);
    }

    #[tokio::test]
    async fn batches_by_limit() {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(POST).path("/gql");
            then.status(200)
                .json_body(serde_json::json!({"data": {"usersByID": []}}));
        });
        let users = SevenTvUsers::with_url(reqwest::Client::new(), server.url("/gql"));
        let many: Vec<String> = (0..=IDS_PER_REQUEST).map(|i| format!("u{i}")).collect();
        assert!(users.get(&many).await.unwrap().is_empty());
        assert_eq!(mock.calls(), 2);
    }

    #[tokio::test]
    async fn failures_surface_and_are_not_cached() {
        let server = MockServer::start_async().await;
        let mut failing = server.mock(|when, then| {
            when.method(POST).path("/gql");
            then.status(502).body("bad gateway");
        });
        let users = SevenTvUsers::with_url(reqwest::Client::new(), server.url("/gql"));
        let err = users.get(&ids(&["01FE"])).await.unwrap_err();
        assert!(matches!(err, SevenTvError::Api { status: 502, .. }));
        failing.delete();

        let mut gql = server.mock(|when, then| {
            when.method(POST).path("/gql");
            then.status(200).json_body(serde_json::json!({
                "data": null,
                "errors": [{"message": "rate limited"}]
            }));
        });
        let err = users.get(&ids(&["01FE"])).await.unwrap_err();
        assert!(matches!(err, SevenTvError::Gql { ref message } if message == "rate limited"));
        gql.delete();

        let ok = server.mock(|when, then| {
            when.method(POST).path("/gql");
            then.status(200).json_body(serde_json::json!({
                "data": {"usersByID": [{"id": "01FE", "username": "xqc", "display_name": "xQc"}]}
            }));
        });
        assert_eq!(users.get(&ids(&["01FE"])).await.unwrap().len(), 1);
        assert_eq!(ok.calls(), 1);
    }

    #[test]
    fn errors_serialize_with_kind() {
        let v = serde_json::to_value(SevenTvError::Api {
            status: 502,
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "api", "status": 502, "message": "x"})
        );
    }
}
