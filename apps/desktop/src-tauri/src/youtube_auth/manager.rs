//! `AuthManager` for YouTube — façade over the `oauth_pkce` building
//! blocks plus a [`TokenStore`] for keychain persistence.
//!
//! Mirrors `twitch_auth::AuthManager` shape but the underlying flow is
//! Authorization Code + PKCE (RFC 7636) over a loopback redirect (RFC
//! 8252 §7.3) instead of the Device Code Grant. Single-account per
//! ADR 30, proactive refresh per ADR 29, eager re-auth on
//! `invalid_grant` per ADR 31.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde::Deserialize;
use url::Url;

use super::errors::AuthError;
use super::storage::TokenStore;
use super::tokens::YouTubeTokens;
use super::{
    GOOGLE_AUTH_ENDPOINT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_ENDPOINT,
    YOUTUBE_CHANNELS_ENDPOINT,
};
use crate::oauth_pkce::{
    exchange_code, refresh_tokens as pkce_refresh, LoopbackServer, Pkce, State, TokenResponse,
};

/// Proactive refresh threshold per ADR 29.
pub const REFRESH_THRESHOLD_MS: i64 = 5 * 60 * 1000;

/// Wall-clock ceiling on `complete_login` waiting for the loopback
/// redirect. Bounds stuck tasks if the user closes the browser tab
/// without completing the consent screen.
const LOGIN_TIMEOUT_SECS: u64 = 300;

pub struct AuthManagerBuilder {
    client_id: String,
    client_secret: String,
    auth_endpoint: String,
    token_endpoint: String,
    channels_endpoint: String,
    scopes: Vec<String>,
}

impl AuthManagerBuilder {
    pub fn new(client_id: impl Into<String>, client_secret: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            auth_endpoint: GOOGLE_AUTH_ENDPOINT.to_string(),
            token_endpoint: GOOGLE_TOKEN_ENDPOINT.to_string(),
            channels_endpoint: YOUTUBE_CHANNELS_ENDPOINT.to_string(),
            scopes: Vec::new(),
        }
    }

    #[must_use]
    pub fn scope(mut self, scope: impl Into<String>) -> Self {
        self.scopes.push(scope.into());
        self
    }

    /// Override the OAuth endpoints. Tests use this to point the
    /// manager at an httpmock instance; production uses defaults.
    #[must_use]
    pub fn endpoints(
        mut self,
        auth_endpoint: impl Into<String>,
        token_endpoint: impl Into<String>,
        channels_endpoint: impl Into<String>,
    ) -> Self {
        self.auth_endpoint = auth_endpoint.into();
        self.token_endpoint = token_endpoint.into();
        self.channels_endpoint = channels_endpoint.into();
        self
    }

    pub fn build<S: TokenStore + 'static>(
        self,
        store: S,
        http_client: reqwest::Client,
    ) -> AuthManager {
        AuthManager {
            client_id: self.client_id,
            client_secret: self.client_secret,
            auth_endpoint: self.auth_endpoint,
            token_endpoint: self.token_endpoint,
            channels_endpoint: self.channels_endpoint,
            scopes: self.scopes,
            http_client,
            store: Arc::new(store),
        }
    }
}

pub struct AuthManager {
    client_id: String,
    client_secret: String,
    auth_endpoint: String,
    token_endpoint: String,
    channels_endpoint: String,
    scopes: Vec<String>,
    http_client: reqwest::Client,
    store: Arc<dyn TokenStore>,
}

impl AuthManager {
    pub fn builder(
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
    ) -> AuthManagerBuilder {
        AuthManagerBuilder::new(client_id, client_secret)
    }

    /// Builder pre-seeded with the production Google constants.
    pub fn google() -> AuthManagerBuilder {
        AuthManagerBuilder::new(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
    }

    #[must_use]
    pub fn http_client(&self) -> &reqwest::Client {
        &self.http_client
    }

    pub async fn load_or_refresh(&self) -> Result<YouTubeTokens, AuthError> {
        let Some(stored) = self.store.load()? else {
            return Err(AuthError::NoTokens);
        };

        if !stored.needs_refresh(Utc::now().timestamp_millis(), REFRESH_THRESHOLD_MS) {
            return Ok(stored);
        }

        handle_refresh_result(self.refresh(&stored).await, self.store.as_ref())
    }

    /// Binds the loopback listener, generates a PKCE pair + CSRF state,
    /// and returns a [`PendingLogin`] holding both — plus the
    /// `authorization_uri` the caller should open in the user's
    /// browser. The flow is consumed by [`AuthManager::complete_login`]
    /// which awaits the redirect and exchanges the code.
    pub async fn start_login(&self) -> Result<PendingLogin, AuthError> {
        let server = LoopbackServer::bind()
            .await
            .map_err(|e| AuthError::LoopbackBind(e.to_string()))?;
        let pkce = Pkce::generate()?;
        let state = State::generate()?;
        let redirect_uri = server.redirect_uri();

        let authorization_uri = build_authorization_uri(
            &self.auth_endpoint,
            &self.client_id,
            &redirect_uri,
            &self.scopes,
            &pkce,
            &state,
        )?;

        Ok(PendingLogin {
            server,
            pkce,
            state,
            authorization_uri,
            redirect_uri,
        })
    }

    /// Awaits the loopback redirect, validates the CSRF state, exchanges
    /// the authorization code for tokens, fetches the channel identity,
    /// and persists the result.
    pub async fn complete_login(&self, pending: PendingLogin) -> Result<YouTubeTokens, AuthError> {
        let PendingLogin {
            server,
            pkce,
            state,
            redirect_uri,
            ..
        } = pending;
        // RFC 8252 doesn't pin a number; 5 minutes is generous for a
        // user toggling to the browser, completing Google's account
        // chooser + 2FA, and toggling back, while still bounding stuck
        // tasks if the tab is closed without completing.
        let redirect = tokio::time::timeout(
            Duration::from_secs(LOGIN_TIMEOUT_SECS),
            server.wait_for_redirect(),
        )
        .await
        .map_err(|_| AuthError::Timeout)??;
        let (code, returned_state) = redirect.into_code_and_state()?;
        if returned_state != state.as_str() {
            return Err(AuthError::StateMismatch);
        }

        let response = exchange_code(
            &self.http_client,
            &self.token_endpoint,
            &[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("code", code.as_str()),
                ("code_verifier", pkce.verifier.as_str()),
                ("redirect_uri", redirect_uri.as_str()),
                ("grant_type", "authorization_code"),
            ],
        )
        .await?;

        let identity = self.fetch_channel(&response.access_token).await?;
        let tokens = tokens_from_response(&response, identity, None)?;
        self.store.save(&tokens)?;
        Ok(tokens)
    }

    /// Returns the stored channel title without contacting Google. UI
    /// uses this on every poll to render "Logged in as <Channel>"
    /// without paying for a network round-trip.
    pub fn peek_channel_title(&self) -> Result<Option<String>, AuthError> {
        Ok(self.store.load()?.map(|t| t.channel_title))
    }

    pub fn logout(&self) -> Result<(), AuthError> {
        self.store.delete()
    }

    async fn refresh(&self, stored: &YouTubeTokens) -> Result<YouTubeTokens, AuthError> {
        let response = pkce_refresh(
            &self.http_client,
            &self.token_endpoint,
            &[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("refresh_token", stored.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ],
        )
        .await?;
        tokens_from_response(
            &response,
            ChannelIdentity {
                channel_id: stored.channel_id.clone(),
                channel_title: stored.channel_title.clone(),
            },
            Some(&stored.refresh_token),
        )
    }

    async fn fetch_channel(&self, access_token: &str) -> Result<ChannelIdentity, AuthError> {
        // RequestBuilder::query() lives behind a reqwest feature we
        // don't enable; build the URL ourselves with `url::Url`.
        let mut url = Url::parse(&self.channels_endpoint)
            .map_err(|e| AuthError::OAuth(format!("invalid channels endpoint: {e}")))?;
        url.query_pairs_mut()
            .append_pair("part", "snippet")
            .append_pair("mine", "true");

        let response = self
            .http_client
            .get(url.as_str())
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| AuthError::OAuth(format!("youtube channels request failed: {e}")))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| AuthError::OAuth(format!("youtube channels body read failed: {e}")))?;

        if !status.is_success() {
            return Err(AuthError::OAuth(format!(
                "youtube channels {status}: {body}"
            )));
        }

        let parsed: ChannelsResponse = serde_json::from_str(&body)?;
        let item = parsed
            .items
            .into_iter()
            .next()
            .ok_or(AuthError::NoChannel)?;

        Ok(ChannelIdentity {
            channel_id: item.id,
            channel_title: item.snippet.title,
        })
    }
}

/// Opaque handle returned by [`AuthManager::start_login`].
pub struct PendingLogin {
    server: LoopbackServer,
    pkce: Pkce,
    state: State,
    authorization_uri: String,
    redirect_uri: String,
}

impl PendingLogin {
    #[must_use]
    pub fn authorization_uri(&self) -> &str {
        &self.authorization_uri
    }

    #[must_use]
    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }
}

#[derive(Debug, Deserialize)]
struct ChannelsResponse {
    #[serde(default)]
    items: Vec<ChannelItem>,
}

#[derive(Debug, Deserialize)]
struct ChannelItem {
    id: String,
    snippet: ChannelSnippet,
}

#[derive(Debug, Deserialize)]
struct ChannelSnippet {
    title: String,
}

struct ChannelIdentity {
    channel_id: String,
    channel_title: String,
}

fn build_authorization_uri(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    pkce: &Pkce,
    state: &State,
) -> Result<String, AuthError> {
    let scope = scopes.join(" ");
    let mut url = Url::parse(endpoint)
        .map_err(|e| AuthError::OAuth(format!("invalid auth endpoint {endpoint:?}: {e}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &scope)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state.as_str())
        // `access_type=offline` is what makes Google return a
        // refresh_token; without it the response is access-only.
        .append_pair("access_type", "offline")
        // `prompt=consent` forces re-issuance of the refresh_token even
        // for users who've previously consented. Without it Google
        // skips the refresh_token in the response on subsequent grants
        // and our store ends up with no way to refresh.
        .append_pair("prompt", "consent");
    Ok(url.into())
}

fn tokens_from_response(
    response: &TokenResponse,
    identity: ChannelIdentity,
    fallback_refresh: Option<&str>,
) -> Result<YouTubeTokens, AuthError> {
    // Google sometimes omits `refresh_token` from refresh responses
    // (it's only re-issued when the consent set changes), but it MUST
    // be present on the initial code-for-token exchange when we sent
    // `access_type=offline`. If neither the response nor the stored
    // fallback carries one we'd save unusable credentials and trip
    // refresh forever — fail closed instead.
    let refresh_token = response
        .refresh_token
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or_else(|| {
            fallback_refresh
                .filter(|t| !t.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| {
            AuthError::OAuth(
                "token response missing refresh_token and no stored token to fall back to"
                    .to_string(),
            )
        })?;

    Ok(YouTubeTokens {
        access_token: response.access_token.clone(),
        refresh_token,
        expires_at_ms: compute_expires_at_ms(
            Utc::now().timestamp_millis(),
            Duration::from_secs(response.expires_in),
        ),
        scopes: response
            .scope
            .as_deref()
            .map(|s| s.split(' ').map(str::to_string).collect())
            .unwrap_or_default(),
        channel_id: identity.channel_id,
        channel_title: identity.channel_title,
    })
}

/// Overflow-safe absolute expiry timestamp. Same rationale as the
/// twitch_auth equivalent — saturating beats panicking inside the
/// supervisor's hot path.
fn compute_expires_at_ms(now_ms: i64, expires_in: Duration) -> i64 {
    let expires_in_ms = i64::try_from(expires_in.as_millis()).unwrap_or(i64::MAX);
    now_ms.saturating_add(expires_in_ms)
}

fn handle_refresh_result(
    result: Result<YouTubeTokens, AuthError>,
    store: &dyn TokenStore,
) -> Result<YouTubeTokens, AuthError> {
    match result {
        Ok(refreshed) => {
            store.save(&refreshed)?;
            Ok(refreshed)
        }
        Err(AuthError::RefreshTokenInvalid) => {
            let _ = store.delete();
            Err(AuthError::RefreshTokenInvalid)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::youtube_auth::storage::MemoryStore;

    fn test_http_client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client")
    }

    #[test]
    fn build_authorization_uri_includes_required_params() {
        let pkce = Pkce::generate().unwrap();
        let state = State::generate().unwrap();
        let uri = build_authorization_uri(
            "https://accounts.google.com/o/oauth2/v2/auth",
            "client123.apps.googleusercontent.com",
            "http://127.0.0.1:54321",
            &["a".into(), "b".into()],
            &pkce,
            &state,
        )
        .unwrap();
        assert!(uri.contains("client_id=client123.apps.googleusercontent.com"));
        assert!(uri.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321"));
        assert!(uri.contains("response_type=code"));
        assert!(uri.contains("scope=a+b"));
        assert!(uri.contains(&format!("code_challenge={}", pkce.challenge)));
        assert!(uri.contains("code_challenge_method=S256"));
        assert!(uri.contains(&format!("state={}", state.as_str())));
        assert!(uri.contains("access_type=offline"));
        assert!(uri.contains("prompt=consent"));
    }

    #[test]
    fn build_authorization_uri_returns_error_on_bad_endpoint() {
        let pkce = Pkce::generate().unwrap();
        let state = State::generate().unwrap();
        let err = build_authorization_uri(
            "not a url",
            "client",
            "http://127.0.0.1:1",
            &[],
            &pkce,
            &state,
        )
        .unwrap_err();
        assert!(matches!(err, AuthError::OAuth(_)));
    }

    #[test]
    fn compute_expires_at_ms_happy_path() {
        let got = compute_expires_at_ms(1_000, Duration::from_secs(3600));
        assert_eq!(got, 1_000 + 3_600_000);
    }

    #[test]
    fn compute_expires_at_ms_saturates() {
        let got = compute_expires_at_ms(i64::MAX - 10, Duration::from_secs(3600));
        assert_eq!(got, i64::MAX);
    }

    fn sample_tokens() -> YouTubeTokens {
        YouTubeTokens {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at_ms: 1_000_000,
            scopes: vec!["scope-a".into()],
            channel_id: "UC123".into(),
            channel_title: "Test".into(),
        }
    }

    #[test]
    fn handle_refresh_result_persists_on_success() {
        let store = MemoryStore::default();
        let fresh = sample_tokens();
        handle_refresh_result(Ok(fresh.clone()), &store).unwrap();
        assert_eq!(store.load().unwrap().unwrap(), fresh);
    }

    #[test]
    fn handle_refresh_result_evicts_on_invalid_grant() {
        let store = MemoryStore::default();
        store.save(&sample_tokens()).unwrap();
        let err = handle_refresh_result(Err(AuthError::RefreshTokenInvalid), &store).unwrap_err();
        assert!(matches!(err, AuthError::RefreshTokenInvalid));
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn handle_refresh_result_keeps_store_on_transient_error() {
        let store = MemoryStore::default();
        store.save(&sample_tokens()).unwrap();
        let err =
            handle_refresh_result(Err(AuthError::OAuth("network".into())), &store).unwrap_err();
        assert!(matches!(err, AuthError::OAuth(_)));
        assert!(store.load().unwrap().is_some());
    }

    #[test]
    fn tokens_from_response_uses_response_refresh_when_present() {
        let response = TokenResponse {
            access_token: "at".into(),
            refresh_token: Some("rt-new".into()),
            expires_in: 3600,
            scope: Some("a b".into()),
            token_type: Some("Bearer".into()),
        };
        let got = tokens_from_response(
            &response,
            ChannelIdentity {
                channel_id: "UC1".into(),
                channel_title: "T".into(),
            },
            Some("rt-old"),
        )
        .unwrap();
        assert_eq!(got.refresh_token, "rt-new");
        assert_eq!(got.scopes, vec!["a", "b"]);
    }

    #[test]
    fn tokens_from_response_falls_back_to_stored_refresh_when_missing() {
        // Google often omits refresh_token from refresh responses.
        let response = TokenResponse {
            access_token: "at-fresh".into(),
            refresh_token: None,
            expires_in: 3600,
            scope: None,
            token_type: None,
        };
        let got = tokens_from_response(
            &response,
            ChannelIdentity {
                channel_id: "UC1".into(),
                channel_title: "T".into(),
            },
            Some("rt-stored"),
        )
        .unwrap();
        assert_eq!(
            got.refresh_token, "rt-stored",
            "must keep the previous refresh token when Google omits it"
        );
    }

    #[test]
    fn tokens_from_response_errors_when_no_refresh_anywhere() {
        // Initial code-for-token path with `access_type=offline` should
        // always include refresh_token; if Google ever drops it we must
        // fail closed rather than persist credentials we can't refresh.
        let response = TokenResponse {
            access_token: "at".into(),
            refresh_token: None,
            expires_in: 3600,
            scope: None,
            token_type: None,
        };
        let err = tokens_from_response(
            &response,
            ChannelIdentity {
                channel_id: "UC1".into(),
                channel_title: "T".into(),
            },
            None,
        )
        .unwrap_err();
        assert!(matches!(err, AuthError::OAuth(msg) if msg.contains("refresh_token")));
    }

    #[tokio::test]
    async fn load_or_refresh_returns_no_tokens_when_store_empty() {
        let mgr = AuthManager::builder("c", "s").build(MemoryStore::default(), test_http_client());
        match mgr.load_or_refresh().await {
            Err(AuthError::NoTokens) => {}
            Ok(_) => panic!("expected NoTokens, got Ok"),
            Err(_) => panic!("expected NoTokens variant"),
        }
    }

    #[tokio::test]
    async fn load_or_refresh_returns_fresh_tokens_verbatim() {
        let store = Arc::new(MemoryStore::default());

        struct Handle(Arc<MemoryStore>);
        impl TokenStore for Handle {
            fn load(&self) -> Result<Option<YouTubeTokens>, AuthError> {
                self.0.load()
            }
            fn save(&self, t: &YouTubeTokens) -> Result<(), AuthError> {
                self.0.save(t)
            }
            fn delete(&self) -> Result<(), AuthError> {
                self.0.delete()
            }
        }

        let mgr = AuthManager::builder("c", "s").build(Handle(store.clone()), test_http_client());
        let fresh = YouTubeTokens {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at_ms: Utc::now().timestamp_millis() + 60 * 60 * 1000,
            scopes: vec!["x".into()],
            channel_id: "UC".into(),
            channel_title: "T".into(),
        };
        store.save(&fresh).unwrap();

        let got = mgr.load_or_refresh().await.unwrap();
        assert_eq!(got, fresh);
    }
}
