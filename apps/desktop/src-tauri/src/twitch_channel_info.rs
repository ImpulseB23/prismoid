//! The signed-in broadcaster's stream setup: title, category, tags,
//! language, content classification labels and the branded content flag.
//! Read with Helix `GET /channels`, changed with `PATCH /channels` (scope
//! `channel:manage:broadcast`); categories come from `GET /search/categories`
//! and label names from `GET /content_classification_labels`. Every command
//! acts on the user's own channel, since Helix only lets a broadcaster
//! change theirs.

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
    /// ISO 639-1 code, or `other` for a language Twitch does not support.
    #[serde(default)]
    pub broadcaster_language: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Ids of the labels in effect, the ones the category implies included.
    #[serde(default)]
    pub content_classification_labels: Vec<String>,
    #[serde(default)]
    pub is_branded_content: bool,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    data: Vec<ChannelInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelSetting {
    pub id: String,
    pub is_enabled: bool,
}

/// Fields to change; Twitch applies only those present. An empty `game_id`
/// clears the category, empty `tags` clear the tags, and labels missing
/// from `content_classification_labels` keep their state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelInfoUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broadcaster_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_classification_labels: Option<Vec<LabelSetting>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_branded_content: Option<bool>,
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

/// A label's name and description in the requested locale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentLabel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
struct ContentLabelsResponse {
    data: Vec<ContentLabel>,
}

/// Helix limits from the Modify Channel Information reference.
pub const TITLE_MAX_CHARS: usize = 140;
pub const TAGS_MAX: usize = 10;
pub const TAG_MAX_CHARS: usize = 25;

fn invalid(message: String) -> ChannelError {
    ChannelError::InvalidSetting { message }
}

fn check_tags(tags: &[String]) -> Result<(), ChannelError> {
    if tags.len() > TAGS_MAX {
        return Err(invalid(format!("at most {TAGS_MAX} tags")));
    }
    for tag in tags {
        if tag.is_empty() {
            return Err(invalid("tags cannot be empty".into()));
        }
        if tag.chars().count() > TAG_MAX_CHARS {
            return Err(invalid(format!(
                "tags must be at most {TAG_MAX_CHARS} characters"
            )));
        }
        // Letters and digits of any script pass, so accented and CJK tags
        // work; spaces and punctuation are the special characters Twitch
        // rejects.
        if !tag.chars().all(char::is_alphanumeric) {
            return Err(invalid(format!(
                "tag \"{tag}\" can only have letters and numbers"
            )));
        }
    }
    Ok(())
}

pub fn validate_update(u: &ChannelInfoUpdate) -> Result<(), ChannelError> {
    if *u == ChannelInfoUpdate::default() {
        return Err(invalid("nothing to change".into()));
    }
    if let Some(title) = &u.title {
        check_text("title", title, TITLE_MAX_CHARS)?;
    }
    if let Some(tags) = &u.tags {
        check_tags(tags)?;
    }
    if let Some(lang) = &u.broadcaster_language {
        let iso = lang.len() == 2 && lang.bytes().all(|b| b.is_ascii_lowercase());
        if !iso && lang != "other" {
            return Err(invalid(
                "language must be a two-letter ISO 639-1 code or other".into(),
            ));
        }
    }
    Ok(())
}

/// The channel's current or last setup; `None` when Helix does not know
/// the id.
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
/// change with 204, the category name only comes from a read, and the read
/// is the only sign that Twitch skipped an unsupported language.
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
    .await
    .map_err(|e| match e {
        ChannelError::Helix {
            status: 403,
            message,
        } if update.content_classification_labels.is_some() => {
            ChannelError::LabelsNotAllowed { message }
        }
        ChannelError::Helix {
            status: 409,
            message,
        } if update.is_branded_content.is_some() => {
            ChannelError::BrandedContentCooldown { message }
        }
        e => e,
    })?;
    let channel = fetch_channel_info(http, helix_base, access_token, broadcaster_id)
        .await?
        .ok_or_else(|| ChannelError::Http {
            message: "empty channel response".into(),
        })?;
    match &update.broadcaster_language {
        Some(lang) if *lang != channel.broadcaster_language => {
            Err(ChannelError::LanguageNotSupported {
                language: lang.clone(),
                channel: Box::new(channel),
            })
        }
        _ => Ok(channel),
    }
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

/// Every label Twitch defines, worded for `locale` (for example `de-DE`).
pub async fn fetch_content_labels(
    http: &reqwest::Client,
    helix_base: &str,
    access_token: &str,
    locale: &str,
) -> Result<Vec<ContentLabel>, ChannelError> {
    let resp: ContentLabelsResponse = helix_get(
        http,
        format!("{helix_base}/content_classification_labels"),
        &[("locale", locale)],
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

#[tauri::command]
pub async fn twitch_get_content_labels(
    auth: State<'_, AuthState>,
    channels: State<'_, ChannelState>,
    locale: String,
) -> Result<Vec<ContentLabel>, ChannelError> {
    let tokens = auth.manager.load_or_refresh().await?;
    fetch_content_labels(
        auth.manager.http_client(),
        channels.helix_base(),
        &tokens.access_token,
        &locale,
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

    async fn patch(server: &MockServer, update: &ChannelInfoUpdate) -> ChannelError {
        update_channel_info(
            &reqwest::Client::new(),
            &server.base_url(),
            "t",
            "7",
            update,
        )
        .await
        .unwrap_err()
    }

    #[tokio::test]
    async fn fetch_reads_the_whole_setup() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/channels")
                .query_param("broadcaster_id", "7")
                .header("Authorization", "Bearer tok");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "broadcaster_id": "7",
                    "broadcaster_login": "me",
                    "broadcaster_name": "Me",
                    "broadcaster_language": "de",
                    "game_id": "509658",
                    "game_name": "Just Chatting",
                    "title": "hello",
                    "delay": 0,
                    "tags": ["Deutsch", "Chill"],
                    "content_classification_labels": ["Gambling", "MatureGame"],
                    "is_branded_content": true
                }]
            }));
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
                broadcaster_language: "de".into(),
                tags: vec!["Deutsch".into(), "Chill".into()],
                content_classification_labels: vec!["Gambling".into(), "MatureGame".into()],
                is_branded_content: true,
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
            ..Default::default()
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
    async fn update_sends_tags_language_labels_and_branded_content() {
        let server = MockServer::start_async().await;
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/channels")
                .json_body(serde_json::json!({
                    "broadcaster_language": "en",
                    "tags": [],
                    "content_classification_labels": [
                        { "id": "Gambling", "is_enabled": true },
                        { "id": "DrugsIntoxication", "is_enabled": false }
                    ],
                    "is_branded_content": true
                }));
            then.status(204);
        });
        server.mock(|when, then| {
            when.method(GET).path("/channels");
            then.status(200).json_body(channel_json("t", "", ""));
        });
        let update = ChannelInfoUpdate {
            broadcaster_language: Some("en".into()),
            tags: Some(Vec::new()),
            content_classification_labels: Some(vec![
                LabelSetting {
                    id: "Gambling".into(),
                    is_enabled: true,
                },
                LabelSetting {
                    id: "DrugsIntoxication".into(),
                    is_enabled: false,
                },
            ]),
            is_branded_content: Some(true),
            ..Default::default()
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
        assert_eq!(got.broadcaster_language, "en");
    }

    #[tokio::test]
    async fn update_rejects_bad_titles_before_calling_helix() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(204);
        });
        for title in ["   ".to_owned(), "x".repeat(TITLE_MAX_CHARS + 1)] {
            let update = ChannelInfoUpdate {
                title: Some(title),
                ..Default::default()
            };
            let err = patch(&server, &update).await;
            assert!(matches!(err, ChannelError::InvalidSetting { .. }));
        }
        assert!(validate_update(&ChannelInfoUpdate::default()).is_err());
        // Twitch counts characters, so a full-width title fits.
        let wide = ChannelInfoUpdate {
            title: Some("あ".repeat(TITLE_MAX_CHARS)),
            ..Default::default()
        };
        assert!(validate_update(&wide).is_ok());
        assert_eq!(any.calls(), 0);
    }

    #[tokio::test]
    async fn update_rejects_bad_tags_before_calling_helix() {
        let server = MockServer::start_async().await;
        let any = server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(204);
        });
        let too_many: Vec<String> = (0..=TAGS_MAX).map(|i| format!("tag{i}")).collect();
        let bad = [
            too_many,
            vec![String::new()],
            vec!["x".repeat(TAG_MAX_CHARS + 1)],
            vec!["two words".into()],
            vec!["no-dash".into()],
            vec!["under_score".into()],
            vec!["hash#".into()],
        ];
        for tags in bad {
            let update = ChannelInfoUpdate {
                tags: Some(tags.clone()),
                ..Default::default()
            };
            let err = patch(&server, &update).await;
            assert!(
                matches!(err, ChannelError::InvalidSetting { .. }),
                "{tags:?}"
            );
        }
        assert_eq!(any.calls(), 0);

        let fine = [
            Vec::new(),
            (0..TAGS_MAX).map(|i| format!("tag{i}")).collect(),
            vec!["x".repeat(TAG_MAX_CHARS), "日本語".into(), "Español".into()],
            vec!["あ".repeat(TAG_MAX_CHARS)],
        ];
        for tags in fine {
            let update = ChannelInfoUpdate {
                tags: Some(tags.clone()),
                ..Default::default()
            };
            assert!(validate_update(&update).is_ok(), "{tags:?}");
        }
    }

    #[test]
    fn language_must_be_iso_639_1_or_other() {
        let check = |lang: &str| {
            validate_update(&ChannelInfoUpdate {
                broadcaster_language: Some(lang.into()),
                ..Default::default()
            })
        };
        for ok in ["en", "ja", "other"] {
            assert!(check(ok).is_ok(), "{ok}");
        }
        for bad in ["", "EN", "eng", "en-US", "e1", "Other"] {
            assert!(
                matches!(check(bad), Err(ChannelError::InvalidSetting { .. })),
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn skipped_language_is_reported_with_the_applied_rest() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(204);
        });
        server.mock(|when, then| {
            when.method(GET).path("/channels");
            then.status(200).json_body(channel_json("new", "", ""));
        });
        let update = ChannelInfoUpdate {
            title: Some("new".into()),
            broadcaster_language: Some("zu".into()),
            ..Default::default()
        };
        match patch(&server, &update).await {
            ChannelError::LanguageNotSupported { language, channel } => {
                assert_eq!(language, "zu");
                assert_eq!(channel.title, "new");
                assert_eq!(channel.broadcaster_language, "en");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn refused_labels_get_their_own_error() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(403)
                .body("User requested gaming CCLs to be added to their channel");
        });
        let update = ChannelInfoUpdate {
            content_classification_labels: Some(vec![LabelSetting {
                id: "MatureGame".into(),
                is_enabled: true,
            }]),
            ..Default::default()
        };
        assert!(matches!(
            patch(&server, &update).await,
            ChannelError::LabelsNotAllowed { message } if message.contains("gaming CCLs")
        ));

        let title_only = ChannelInfoUpdate {
            title: Some("t".into()),
            ..Default::default()
        };
        assert!(matches!(
            patch(&server, &title_only).await,
            ChannelError::Helix { status: 403, .. }
        ));
    }

    #[tokio::test]
    async fn branded_content_too_often_gets_its_own_error() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(PATCH).path("/channels");
            then.status(409)
                .body("User set the Branded Content flag too frequently");
        });
        let update = ChannelInfoUpdate {
            is_branded_content: Some(false),
            ..Default::default()
        };
        assert!(matches!(
            patch(&server, &update).await,
            ChannelError::BrandedContentCooldown { .. }
        ));

        let tags_only = ChannelInfoUpdate {
            tags: Some(Vec::new()),
            ..Default::default()
        };
        assert!(matches!(
            patch(&server, &tags_only).await,
            ChannelError::Helix { status: 409, .. }
        ));
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
            ..Default::default()
        };
        assert!(matches!(
            patch(&server, &update).await,
            ChannelError::Helix { status: 401, .. }
        ));
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

    #[tokio::test]
    async fn content_labels_come_in_the_requested_locale() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET)
                .path("/content_classification_labels")
                .query_param("locale", "de-DE")
                .header("Authorization", "Bearer t");
            then.status(200).json_body(serde_json::json!({
                "data": [{
                    "id": "Gambling",
                    "description": "Teilnahme an Glücksspielen um echtes Geld.",
                    "name": "Glücksspiel"
                }]
            }));
        });
        let got = fetch_content_labels(&reqwest::Client::new(), &server.base_url(), "t", "de-DE")
            .await
            .unwrap();
        assert_eq!(
            got,
            vec![ContentLabel {
                id: "Gambling".into(),
                name: "Glücksspiel".into(),
                description: "Teilnahme an Glücksspielen um echtes Geld.".into(),
            }]
        );
    }

    #[tokio::test]
    async fn content_labels_surface_helix_errors() {
        let server = MockServer::start_async().await;
        server.mock(|when, then| {
            when.method(GET).path("/content_classification_labels");
            then.status(400).body("bad locale");
        });
        let err = fetch_content_labels(&reqwest::Client::new(), &server.base_url(), "t", "xx")
            .await
            .unwrap_err();
        assert!(matches!(err, ChannelError::Helix { status: 400, .. }));
    }
}
