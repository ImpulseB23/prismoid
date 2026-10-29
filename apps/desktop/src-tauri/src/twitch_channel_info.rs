//! The signed-in broadcaster's stream title and category. Read with Helix
//! `GET /channels`, changed with `PATCH /channels` (scope
//! `channel:manage:broadcast`); categories come from
//! `GET /search/categories`. Every command acts on the user's own channel,
//! since Helix only lets a broadcaster change theirs.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::twitch_auth::AuthState;
use crate::twitch_channel::{check_text, helix_get, helix_write, ChannelError, ChannelState};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelInfo {
    #[serde(default)]
    pub broadcaster_id: String,
    #[serde(default)]
    pub title: String,
    /// Empty when no category is set.
    #[serde(default)]
    pub game_id: String,
    #[serde(default)]
    pub game_name: String,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    data: Vec<ChannelInfo>,
}

/// Fields to change; Twitch applies only those present. An empty `game_id`
/// clears the category.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelInfoUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub box_art_url: String,
}

#[derive(Deserialize)]
struct CategoriesResponse {
    data: Vec<Category>,
}

/// Helix limit from the Modify Channel Information reference.
pub const TITLE_MAX_CHARS: usize = 140;

pub fn validate_update(u: &ChannelInfoUpdate) -> Result<(), ChannelError> {
    if u.title.is_none() && u.game_id.is_none() {
        return Err(ChannelError::InvalidSetting {
            message: "nothing to change".into(),
        });
    }
    if let Some(title) = &u.title {
        check_text("title", title, TITLE_MAX_CHARS)?;
    }
    Ok(())
}

/// The channel's current or last title and category; `None` when Helix
/// does not know the id.
pub async fn fetch_channel_info(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
) -> Result<Option<ChannelInfo>, ChannelError> {
    let resp: ChannelsResponse = helix_get(
        http,
        format!("{helix_base}/channels"),
        &[("broadcaster_id", broadcaster_id)],
        access_token,
    )
    .await?;
    Ok(resp.data.into_iter().next())
}

/// Applies the update, then reads the channel back: Helix answers the
/// change with 204 and the category name only comes from a read.
pub async fn update_channel_info(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    broadcaster_id: &str,
    update: &ChannelInfoUpdate,
) -> Result<ChannelInfo, ChannelError> {
    validate_update(update)?;
    helix_write(
        http,
        reqwest::Method::PATCH,
        format!("{helix_base}/channels"),
        &[("broadcaster_id", broadcaster_id)],
        access_token,
        update,
    )
    .await?;
    fetch_channel_info(http, helix_base, access_token, broadcaster_id)
        .await?
        .ok_or_else(|| ChannelError::Http {
            message: "empty channel response".into(),
        })
}

pub async fn search_categories(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    query: &str,
) -> Result<Vec<Category>, ChannelError> {
    let resp: CategoriesResponse = helix_get(
        http,
        format!("{helix_base}/search/categories"),
        &[("query", query)],
        access_token,
    )
    .await?;
    Ok(resp.data)
}

#[tauri::command]
pub async fn twitch_get_channel_info(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
) -> Result<Option<ChannelInfo>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_channel_info(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
    )
    .await
}

#[tauri::command]
pub async fn twitch_update_channel_info(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    update: ChannelInfoUpdate,
) -> Result<ChannelInfo, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    update_channel_info(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &tokens.user_id,
        &update,
    )
    .await
}

#[tauri::command]
pub async fn twitch_search_categories(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    query: String,
) -> Result<Vec<Category>, ChannelError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let tokens = auth.manager.load_or_refresh().await?;
    search_categories(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        query,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    fn channel_json(title: &str, game_id: &str, game_name: &str) -> serde_json::Value {
        serde_json::json!({
            "data": [{
                "broadcaster_id": "7",
                "broadcaster_login": "me",
                "broadcaster_name": "Me",
                "broadcaster_language": "en",
                "game_id": game_id,
                "game_name": game_name,
                "title": title,
                "delay": 0,
                "tags": [],
                "content_classification_labels": [],
                "is_branded_content": false
            }]
        })
    }

    #[tokio::test]
    async fn fetch_reads_title_and_category() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/channels")
                .query_param("broadcaster_id", "7")
                .header("Authorization", "Bearer tok");
            then.status(200)
                .json_body(channel_json("hello", "509658", "Just Chatting"));
        });
        let got = fetch_channel_info(&reqwest::Client::new(), &server.base_url(), "tok", "7")
            .await
            .unwrap();
        assert_eq!(
            got,
            Some(ChannelInfo {
                broadcaster_id: "7".into(),
                title: "hello".into(),
                game_id: "509658".into(),
                game_name: "Just Chatting".into(),
            })
        );
    }

    #[tokio::test]
    async fn fetch_unknown_channel_is_none() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/channels");
            then.status(200)
                .json_body(serde_json::json!({ "data": [] }));
        });
        let got = fetch_channel_info(&reqwest::Client::new(), &server.base_url(), "t", "7")
            .await
            .unwrap();
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn update_patches_then_reads_back() {
        let server = MockServer::start_async().await;
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/channels")
                .query_param("broadcaster_id", "7")
                .header("Content-Type", "application/json")
                .json_body(serde_json::json!({ "title": "new", "game_id": "" }));
            then.status(204);
        });
        server.mock(|when, then| {
            when.method(GET).path("/channels");
            then.status(200).json_body(channel_json("new", "", ""));
        });
        let update = ChannelInfoUpdate {
            title: Some("new".into()),
            game_id: Some(String::new()),
        };
        let got = update_channel_info(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "7",
            &update,
        )
        .await
        .unwrap();
        assert_eq!(patch.calls(), 1);
        assert_eq!(got.title, "new");
        assert_eq!(got.game_id, "");
    }

    #[tokio::test]
    async fn update_rejects_bad_titles_before_calling_helix() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(204);
        });
        let http = reqwest::Client::new();
        for title in ["   ".to_owned(), "x".repeat(TITLE_MAX_CHARS + 1)] {
            let update = ChannelInfoUpdate {
                title: Some(title),
                game_id: None,
            };
            let err = update_channel_info(&http, &server.base_url(), "t", "7", &update)
                .await
                .unwrap_err();
            assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        }
        assert!(validate_update(&ChannelInfoUpdate::default()).is_err());
        // Twitch counts characters, so a full-width title fits.
        let wide = ChannelInfoUpdate {
            title: Some("あ".repeat(TITLE_MAX_CHARS)),
            game_id: None,
        };
        assert!(validate_update(&wide).is_ok());
        assert_eq!(any.calls(), 0);
    }

    #[tokio::test]
    async fn update_surfaces_helix_errors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(401).body("missing channel:manage:broadcast");
        });
        let update = ChannelInfoUpdate {
            title: Some("t".into()),
            game_id: None,
        };
        let err = update_channel_info(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "7",
            &update,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 401, .. }));
    }

    #[tokio::test]
    async fn search_returns_categories() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/search/categories")
                .query_param("query", "fort nite");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "id": "33214",
                    "name": "Fortnite",
                    "box_art_url": "https://static-cdn.jtvnw.net/ttv-boxart/33214-52x72.jpg"
                }],
                "pagination": { "cursor": "abc" }
            }));
        });
        let got = search_categories(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "fort nite",
        )
        .await
        .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "33214");
        assert_eq!(got[0].name, "Fortnite");
    }
}
