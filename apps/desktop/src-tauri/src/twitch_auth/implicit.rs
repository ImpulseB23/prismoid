//! Twitch sign-in through the implicit grant (ADR 43).
//!
//! Twitch redirects to the hosted page at prismoid.org, which opens the
//! `prismoid://auth/twitch` deep link carrying Twitch's answer. The OS
//! hands that link to the running instance (the single-instance plugin
//! forwards it when Windows spawns a second process), the state is checked
//! against the login that is waiting, and the token is validated before it
//! is stored.

use std::time::Duration;

use tokio::sync::{mpsc, Notify};
use twitch_oauth2::tokens::errors::ImplicitUserTokenExchangeError;
use twitch_oauth2::tokens::ImplicitUserTokenBuilder;
use twitch_oauth2::url::Url;
use twitch_oauth2::{ClientId, Scope, UserToken};

use super::errors::{error_chain, AuthError};

/// Registered on the Twitch application; the page there forwards to the
/// deep link.
pub const TWITCH_REDIRECT_URL: &str = "https://prismoid.org/auth/twitch";
/// Scheme the installer registers for the app; the hosted page opens
/// `prismoid://auth/twitch?...`.
pub const DEEP_LINK_SCHEME: &str = "prismoid";
const DEEP_LINK_HOST: &str = "auth";
const DEEP_LINK_PATH: &str = "/twitch";
/// How long the browser gets before the pending login gives up.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What Twitch sent back, lifted off the deep link.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallbackParams {
    pub access_token: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

impl CallbackParams {
    /// Reads `prismoid://auth/twitch?...`; any other link is not ours.
    pub fn from_deep_link(url: &Url) -> Option<Self> {
        if url.scheme() != DEEP_LINK_SCHEME
            || url.host_str() != Some(DEEP_LINK_HOST)
            || url.path() != DEEP_LINK_PATH
        {
            return None;
        }
        let mut params = Self::default();
        for (k, v) in url.query_pairs() {
            let v = v.into_owned();
            match &*k {
                "access_token" => params.access_token = Some(v),
                "state" => params.state = Some(v),
                "error" => params.error = Some(v),
                "error_description" => params.error_description = Some(v),
                _ => {}
            }
        }
        Some(params)
    }
}

/// A sign-in that has opened the browser and is waiting for Twitch's
/// answer to arrive over the deep link.
pub struct PendingLogin {
    builder: ImplicitUserTokenBuilder,
}

impl PendingLogin {
    pub fn start(client_id: ClientId, scopes: Vec<Scope>) -> (Self, Url) {
        let redirect = Url::parse(TWITCH_REDIRECT_URL).expect("redirect url is well formed");
        let mut builder = ImplicitUserTokenBuilder::new(client_id, redirect).set_scopes(scopes);
        let (authorize_url, _csrf) = builder.generate_url();
        (Self { builder }, authorize_url)
    }

    /// Waits for Twitch's answer on `incoming`, ignoring links that carry
    /// another login's state, until it arrives, `cancel` fires, or
    /// [`LOGIN_TIMEOUT`] passes.
    pub async fn wait(
        self,
        http: &reqwest::Client,
        incoming: &mut mpsc::UnboundedReceiver<CallbackParams>,
        cancel: &Notify,
    ) -> Result<UserToken, AuthError> {
        self.wait_for(LOGIN_TIMEOUT, http, incoming, cancel).await
    }

    async fn wait_for(
        self,
        timeout: Duration,
        http: &reqwest::Client,
        incoming: &mut mpsc::UnboundedReceiver<CallbackParams>,
        cancel: &Notify,
    ) -> Result<UserToken, AuthError> {
        // Created once so a cancel between two loop turns is not missed.
        let cancelled = cancel.notified();
        tokio::pin!(cancelled);
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            let params = tokio::select! {
                received = incoming.recv() => match received {
                    Some(params) => params,
                    None => return Err(AuthError::LoginCancelled),
                },
                () = &mut cancelled => return Err(AuthError::LoginCancelled),
                () = &mut deadline => return Err(AuthError::LoginTimedOut),
            };
            if !params
                .state
                .as_deref()
                .is_some_and(|s| self.builder.csrf_is_valid(s))
            {
                continue;
            }
            return self
                .builder
                .get_user_token(
                    http,
                    params.state.as_deref(),
                    params.access_token.as_deref(),
                    params.error.as_deref(),
                    params.error_description.as_deref(),
                )
                .await
                .map_err(classify_exchange_error);
        }
    }
}

fn classify_exchange_error<RE>(err: ImplicitUserTokenExchangeError<RE>) -> AuthError
where
    RE: std::error::Error + Send + Sync + 'static,
{
    match err {
        ImplicitUserTokenExchangeError::TwitchError {
            error: Some(code), ..
        } if code == "access_denied" => AuthError::UserDenied,
        ImplicitUserTokenExchangeError::TwitchError { error, description } => {
            AuthError::OAuth(format!(
                "{}: {}",
                error.unwrap_or_else(|| "unknown error".into()),
                description.unwrap_or_default()
            ))
        }
        other => AuthError::OAuth(error_chain(&other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client")
    }

    fn start() -> (PendingLogin, Url) {
        PendingLogin::start(ClientId::new("client".into()), vec![Scope::UserReadChat])
    }

    fn state_of(url: &Url) -> String {
        url.query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .expect("authorize url carries the state")
    }

    #[test]
    fn authorize_url_targets_twitch_with_the_hosted_redirect() {
        let (pending, url) = start();
        assert_eq!(url.host_str(), Some("id.twitch.tv"));
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["response_type"], "token");
        assert_eq!(pairs["redirect_uri"], TWITCH_REDIRECT_URL);
        assert_eq!(pairs["scope"], "user:read:chat");
        assert!(pending.builder.csrf_is_valid(&pairs["state"]));
    }

    #[test]
    fn callback_params_only_read_our_deep_link() {
        let granted = Url::parse(
            "prismoid://auth/twitch?access_token=tok%2B1&scope=user%3Aread%3Achat&state=xyz&token_type=bearer",
        )
        .unwrap();
        let params = CallbackParams::from_deep_link(&granted).expect("ours");
        assert_eq!(params.access_token.as_deref(), Some("tok+1"));
        assert_eq!(params.state.as_deref(), Some("xyz"));
        assert!(params.error.is_none());

        let declined = Url::parse(
            "prismoid://auth/twitch?error=access_denied&error_description=The+user+denied+you+access&state=abc",
        )
        .unwrap();
        let params = CallbackParams::from_deep_link(&declined).expect("ours");
        assert_eq!(params.error.as_deref(), Some("access_denied"));
        assert_eq!(
            params.error_description.as_deref(),
            Some("The user denied you access")
        );

        for other in [
            "prismoid://auth/youtube?state=x",
            "prismoid://settings",
            "https://auth/twitch?state=x",
        ] {
            assert!(
                CallbackParams::from_deep_link(&Url::parse(other).unwrap()).is_none(),
                "{other}"
            );
        }
    }

    #[test]
    fn classify_exchange_error_separates_denial_from_the_rest() {
        let denied = ImplicitUserTokenExchangeError::<std::convert::Infallible>::TwitchError {
            error: Some("access_denied".into()),
            description: Some("The user denied you access".into()),
        };
        assert!(matches!(
            classify_exchange_error(denied),
            AuthError::UserDenied
        ));
        let other = ImplicitUserTokenExchangeError::<std::convert::Infallible>::TwitchError {
            error: Some("invalid_scope".into()),
            description: None,
        };
        match classify_exchange_error(other) {
            AuthError::OAuth(s) => assert!(s.starts_with("invalid_scope"), "{s}"),
            e => panic!("expected OAuth, got {e:?}"),
        }
        assert!(matches!(
            classify_exchange_error(
                ImplicitUserTokenExchangeError::<std::convert::Infallible>::StateMismatch
            ),
            AuthError::OAuth(_)
        ));
    }

    #[tokio::test]
    async fn foreign_state_is_ignored_and_a_declined_grant_ends_the_login() {
        let (pending, url) = start();
        let state = state_of(&url);
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(CallbackParams {
            access_token: Some("abc".into()),
            state: Some("not-ours".into()),
            ..Default::default()
        })
        .unwrap();
        tx.send(CallbackParams {
            error: Some("access_denied".into()),
            error_description: Some("The user denied you access".into()),
            state: Some(state),
            ..Default::default()
        })
        .unwrap();
        let result = pending.wait(&http(), &mut rx, &Notify::new()).await;
        assert!(matches!(result, Err(AuthError::UserDenied)), "{result:?}");
    }

    #[tokio::test]
    async fn cancel_ends_the_wait() {
        let (pending, _) = start();
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let cancel = std::sync::Arc::new(Notify::new());
        let waiter = {
            let cancel = cancel.clone();
            tokio::spawn(async move { pending.wait(&http(), &mut rx, &cancel).await })
        };
        tokio::task::yield_now().await;
        cancel.notify_waiters();
        let result = waiter.await.expect("task");
        assert!(
            matches!(result, Err(AuthError::LoginCancelled)),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn silence_times_out() {
        let (pending, _) = start();
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let result = pending
            .wait_for(Duration::from_millis(20), &http(), &mut rx, &Notify::new())
            .await;
        assert!(
            matches!(result, Err(AuthError::LoginTimedOut)),
            "{result:?}"
        );
    }
}
