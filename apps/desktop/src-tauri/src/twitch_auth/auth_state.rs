//! Auth state and serializable view types shared by the Twitch sign-in
//! commands and the sidecar supervisor. Keeping the business logic out
//! of the `#[tauri::command]` adapters in `commands.rs` lets us test
//! every branch without spinning up a Tauri runtime / WebView2.

use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{mpsc, Mutex, Notify};
use twitch_oauth2::url::Url;
use twitch_oauth2::Scope;

use super::errors::AuthError;
use super::implicit::{CallbackParams, PendingLogin};
use super::manager::AuthManager;
use super::scope_groups::ScopeGroup;
use super::tokens::TwitchTokens;

/// Shared auth state held in Tauri's managed-state map. The supervisor
/// holds a clone of the same `Arc<AuthManager>` and the same
/// `Arc<Notify>` so a successful sign-in immediately wakes the
/// supervisor's `waiting_for_auth` sleep instead of forcing the user
/// to wait up to 30 s for the next poll tick.
pub struct AuthState {
    pub manager: Arc<AuthManager>,
    pub pending: Mutex<Option<PendingLogin>>,
    /// Fired by `cancel_login` so a waiting `complete_login` returns.
    /// `notify_waiters` leaves no permit behind, so a cancel never leaks
    /// into the next attempt.
    cancel: Notify,
    /// Twitch's answers, as the deep-link handler lifts them off
    /// `prismoid://auth/twitch` links. Stale ones are drained before each
    /// wait and the state check discards any that are not for this login.
    incoming: mpsc::UnboundedSender<CallbackParams>,
    receiver: Mutex<mpsc::UnboundedReceiver<CallbackParams>>,
    /// Notifier the supervisor awaits while idle in `waiting_for_auth`.
    /// Successful login + logout both fire it: login so a fresh sidecar
    /// spins up immediately; logout so any in-progress sidecar tears
    /// down on the next loop iteration.
    pub wakeup: Arc<Notify>,
    /// Fired on every completed sign-in. The running sidecar's token loop
    /// wakes on it, so a reconnect that adds scopes reaches EventSub now
    /// instead of at the next refresh tick.
    pub signed_in: Arc<Notify>,
}

impl AuthState {
    pub fn new(manager: Arc<AuthManager>, wakeup: Arc<Notify>) -> Self {
        let (incoming, receiver) = mpsc::unbounded_channel();
        Self {
            manager,
            pending: Mutex::new(None),
            cancel: Notify::new(),
            incoming,
            receiver: Mutex::new(receiver),
            wakeup,
            signed_in: Arc::new(Notify::new()),
        }
    }

    pub fn status(&self) -> Result<AuthStatus, AuthCommandError> {
        Ok(match self.manager.peek_tokens()? {
            Some(tokens) => self.logged_in(&tokens),
            None => AuthStatus {
                state: AuthStatusState::LoggedOut,
                login: None,
                user_id: None,
                missing_scopes: Vec::new(),
                enabled_scope_groups: self.manager.enabled_scope_groups(),
            },
        })
    }

    fn logged_in(&self, tokens: &TwitchTokens) -> AuthStatus {
        AuthStatus {
            state: AuthStatusState::LoggedIn,
            login: Some(tokens.login.clone()),
            user_id: Some(tokens.user_id.clone()),
            missing_scopes: missing_scopes(&self.manager.scopes(), &tokens.scopes),
            enabled_scope_groups: self.manager.enabled_scope_groups(),
        }
    }

    /// Turns the named group on or off. Takes effect at the next sign-in;
    /// until then the returned status lists the scopes it still misses.
    pub fn set_scope_group(&self, name: &str, on: bool) -> Result<AuthStatus, AuthCommandError> {
        self.manager.set_scope_group(name.parse()?, on)?;
        self.status()
    }

    pub async fn start_login(&self) -> Result<LoginView, AuthCommandError> {
        // A previous attempt may still be waiting.
        self.cancel.notify_waiters();
        let (pending, authorize_url) = self.manager.start_login();
        *self.pending.lock().await = Some(pending);
        Ok(LoginView {
            authorize_url: authorize_url.into(),
        })
    }

    pub async fn complete_login(&self) -> Result<AuthStatus, AuthCommandError> {
        let pending = self.pending.lock().await.take().ok_or(AuthCommandError {
            kind: "no_pending_flow",
            message: "twitch_start_login has not been called".into(),
        })?;
        let mut receiver = self.receiver.lock().await;
        while receiver.try_recv().is_ok() {}
        let tokens = self
            .manager
            .complete_login(pending, &mut receiver, &self.cancel)
            .await?;
        // notify_one stores a permit if the supervisor isn't currently
        // parked on notified(), so the wake can't be lost between login
        // completing and the supervisor reaching its await.
        self.wakeup.notify_one();
        self.signed_in.notify_one();
        Ok(self.logged_in(&tokens))
    }

    pub async fn cancel_login(&self) {
        self.cancel.notify_waiters();
        self.pending.lock().await.take();
    }

    /// Called by the deep-link handler for every link the OS delivers;
    /// links that are not Twitch's answer are ignored here.
    pub fn deliver_deep_link(&self, url: &Url) {
        if let Some(params) = CallbackParams::from_deep_link(url) {
            let _ = self.incoming.send(params);
        }
    }

    pub async fn logout(&self) -> Result<(), AuthCommandError> {
        self.manager.logout()?;
        self.cancel.notify_waiters();
        self.pending.lock().await.take();
        self.wakeup.notify_one();
        Ok(())
    }
}

/// Result of `twitch_auth_status`. The frontend uses `state` to pick
/// between the SignIn overlay and the chat view; `login` is rendered
/// in the header bar when logged in. `missing_scopes` lists what the
/// app now asks for that the stored grant lacks, so the UI can offer a
/// reconnect instead of letting moderation fail with a 401.
/// `enabled_scope_groups` names the optional sections the user turned on.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthStatus {
    pub state: AuthStatusState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub missing_scopes: Vec<String>,
    pub enabled_scope_groups: Vec<ScopeGroup>,
}

/// Requested scopes absent from the granted set, in request order.
pub fn missing_scopes(requested: &[Scope], granted: &[String]) -> Vec<String> {
    requested
        .iter()
        .map(|s| s.to_string())
        .filter(|s| !granted.contains(s))
        .collect()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatusState {
    LoggedOut,
    LoggedIn,
}

/// What the frontend needs to send the user to Twitch: the authorize URL
/// with the loopback redirect and CSRF state already in it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LoginView {
    pub authorize_url: String,
}

/// Frontend-facing error. `AuthError` itself isn't `Serialize` (it
/// carries `keyring::Error` / `serde_json::Error`), so we map to a
/// stable tag the UI can switch on plus a human message for diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct AuthCommandError {
    pub kind: &'static str,
    pub message: String,
}

impl From<AuthError> for AuthCommandError {
    fn from(err: AuthError) -> Self {
        let kind = match &err {
            AuthError::NoTokens => "no_tokens",
            AuthError::RefreshTokenInvalid => "refresh_invalid",
            AuthError::LoginTimedOut => "login_timed_out",
            AuthError::LoginCancelled => "login_cancelled",
            AuthError::UserDenied => "user_denied",
            AuthError::Keychain(_) => "keychain",
            AuthError::OAuth(_) => "oauth",
            AuthError::Json(_) => "json",
            AuthError::Config(_) => "config",
            AuthError::UnknownScopeGroup(_) => "unknown_scope_group",
            AuthError::Io(_) => "io",
        };
        Self {
            kind,
            message: err.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::twitch_auth::storage::{MemoryStore, TokenStore};
    use crate::twitch_auth::tokens::TwitchTokens;
    use crate::twitch_auth::AuthManagerBuilder;

    fn http_client() -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client")
    }

    fn fixture_tokens() -> TwitchTokens {
        TwitchTokens {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            expires_at_ms: i64::MAX,
            scopes: vec!["user:read:chat".into()],
            user_id: "12345".into(),
            login: "tester".into(),
        }
    }

    fn build_state_with_store(store: MemoryStore) -> AuthState {
        let manager =
            Arc::new(AuthManagerBuilder::new("test_client_id").build(store, http_client()));
        AuthState::new(manager, Arc::new(Notify::new()))
    }

    #[test]
    fn auth_command_error_maps_no_tokens() {
        let mapped: AuthCommandError = AuthError::NoTokens.into();
        assert_eq!(mapped.kind, "no_tokens");
    }

    #[test]
    fn auth_command_error_maps_refresh_invalid() {
        let mapped: AuthCommandError = AuthError::RefreshTokenInvalid.into();
        assert_eq!(mapped.kind, "refresh_invalid");
    }

    #[test]
    fn auth_command_error_maps_login_outcomes() {
        let cases: [(AuthError, &str); 2] = [
            (AuthError::LoginTimedOut, "login_timed_out"),
            (AuthError::LoginCancelled, "login_cancelled"),
        ];
        for (err, kind) in cases {
            let mapped: AuthCommandError = err.into();
            assert_eq!(mapped.kind, kind);
        }
    }

    #[test]
    fn auth_command_error_maps_user_denied() {
        let mapped: AuthCommandError = AuthError::UserDenied.into();
        assert_eq!(mapped.kind, "user_denied");
    }

    #[test]
    fn auth_command_error_maps_keychain() {
        let mapped: AuthCommandError = AuthError::Keychain(keyring::Error::NoEntry).into();
        assert_eq!(mapped.kind, "keychain");
        assert!(!mapped.message.is_empty());
    }

    #[test]
    fn auth_command_error_maps_json() {
        let json_err = serde_json::from_str::<TwitchTokens>("not json").unwrap_err();
        let mapped: AuthCommandError = AuthError::Json(json_err).into();
        assert_eq!(mapped.kind, "json");
    }

    #[test]
    fn auth_command_error_maps_config() {
        let mapped: AuthCommandError = AuthError::Config("bad scope".into()).into();
        assert_eq!(mapped.kind, "config");
        assert!(mapped.message.contains("bad scope"));
    }

    #[test]
    fn auth_status_serializes_logged_out_without_login_field() {
        let s = AuthStatus {
            state: AuthStatusState::LoggedOut,
            login: None,
            user_id: None,
            missing_scopes: Vec::new(),
            enabled_scope_groups: Vec::new(),
        };
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["state"], "logged_out");
        assert!(
            v.get("login").is_none(),
            "logged_out status should not include login key, got {v}"
        );
    }

    #[test]
    fn auth_status_serializes_logged_in_with_login() {
        let s = AuthStatus {
            state: AuthStatusState::LoggedIn,
            login: Some("tester".into()),
            user_id: Some("12345".into()),
            missing_scopes: vec!["moderator:manage:banned_users".into()],
            enabled_scope_groups: vec![ScopeGroup::Ads, ScopeGroup::LiveActions],
        };
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["state"], "logged_in");
        assert_eq!(v["login"], "tester");
        assert_eq!(v["user_id"], "12345");
        assert_eq!(v["missing_scopes"][0], "moderator:manage:banned_users");
        assert_eq!(
            v["enabled_scope_groups"],
            serde_json::json!(["ads", "live_actions"])
        );
    }

    #[test]
    fn auth_command_error_maps_scope_group_errors() {
        let mapped: AuthCommandError = AuthError::UnknownScopeGroup("nope".into()).into();
        assert_eq!(mapped.kind, "unknown_scope_group");
        assert!(mapped.message.contains("nope"));
        let mapped: AuthCommandError =
            AuthError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).into();
        assert_eq!(mapped.kind, "io");
    }

    #[tokio::test]
    async fn enabled_group_scopes_count_as_missing_until_granted() {
        let store = MemoryStore::default();
        let mut tokens = fixture_tokens();
        tokens.scopes.push("channel:read:ads".into());
        store.save(&tokens).unwrap();
        let manager = Arc::new(
            AuthManagerBuilder::new("test_client_id")
                .scope(Scope::UserReadChat)
                .build(store, http_client()),
        );
        let state = AuthState::new(manager, Arc::new(Notify::new()));
        assert!(state.status().unwrap().missing_scopes.is_empty());

        let status = state.set_scope_group("ads", true).unwrap();
        assert_eq!(status.enabled_scope_groups, [ScopeGroup::Ads]);
        assert_eq!(
            status.missing_scopes,
            ["channel:manage:ads", "channel:edit:commercial"]
        );

        let status = state.set_scope_group("ads", false).unwrap();
        assert!(status.enabled_scope_groups.is_empty());
        assert!(status.missing_scopes.is_empty());
    }

    #[tokio::test]
    async fn groups_show_while_logged_out() {
        let state = build_state_with_store(MemoryStore::default());
        let status = state.set_scope_group("live_actions", true).unwrap();
        assert_eq!(status.state, AuthStatusState::LoggedOut);
        assert_eq!(status.enabled_scope_groups, [ScopeGroup::LiveActions]);
        assert!(status.missing_scopes.is_empty());
    }

    #[tokio::test]
    async fn unknown_group_is_rejected_without_changes() {
        let state = build_state_with_store(MemoryStore::default());
        let err = state.set_scope_group("channel_points", true).unwrap_err();
        assert_eq!(err.kind, "unknown_scope_group");
        assert!(state.status().unwrap().enabled_scope_groups.is_empty());
    }

    #[test]
    fn missing_scopes_keeps_request_order() {
        let requested = [
            Scope::UserReadChat,
            Scope::ModeratorManageBannedUsers,
            Scope::UserWriteChat,
        ];
        let granted = vec!["user:read:chat".to_string()];
        assert_eq!(
            missing_scopes(&requested, &granted),
            vec!["moderator:manage:banned_users", "user:write:chat"]
        );
        let all = vec![
            "user:read:chat".to_string(),
            "moderator:manage:banned_users".to_string(),
            "user:write:chat".to_string(),
        ];
        assert!(missing_scopes(&requested, &all).is_empty());
    }

    #[tokio::test]
    async fn status_reports_scopes_the_stored_grant_lacks() {
        let store = MemoryStore::default();
        store.save(&fixture_tokens()).unwrap();
        let manager = Arc::new(
            AuthManagerBuilder::new("test_client_id")
                .scope(Scope::UserReadChat)
                .scope(Scope::UserWriteChat)
                .build(store, http_client()),
        );
        let state = AuthState::new(manager, Arc::new(Notify::new()));

        let status = state.status().unwrap();
        assert_eq!(status.user_id.as_deref(), Some("12345"));
        assert_eq!(status.missing_scopes, vec!["user:write:chat"]);
    }

    #[tokio::test]
    async fn status_returns_logged_in_when_tokens_present() {
        let store = MemoryStore::default();
        store.save(&fixture_tokens()).unwrap();
        let state = build_state_with_store(store);

        let status = state.status().unwrap();
        assert_eq!(status.state, AuthStatusState::LoggedIn);
        assert_eq!(status.login.as_deref(), Some("tester"));
    }

    #[tokio::test]
    async fn status_returns_logged_out_when_no_tokens() {
        let store = MemoryStore::default();
        let state = build_state_with_store(store);

        let status = state.status().unwrap();
        assert_eq!(status.state, AuthStatusState::LoggedOut);
        assert!(status.login.is_none());
    }

    #[tokio::test]
    async fn complete_login_without_pending_returns_no_pending_flow() {
        let state = build_state_with_store(MemoryStore::default());
        let err = state.complete_login().await.unwrap_err();
        assert_eq!(err.kind, "no_pending_flow");
    }

    #[tokio::test]
    async fn logout_when_empty_store_still_clears_and_notifies() {
        let state = build_state_with_store(MemoryStore::default());
        let wakeup = state.wakeup.clone();

        state.logout().await.unwrap();
        // notify_one stored a permit, so a subsequent notified() resolves
        // immediately even though no waiter was parked at signal time.
        tokio::time::timeout(std::time::Duration::from_secs(1), wakeup.notified())
            .await
            .expect("permit should be available");
    }

    #[tokio::test]
    async fn cancel_login_is_idempotent() {
        let state = build_state_with_store(MemoryStore::default());
        state.cancel_login().await;
        state.cancel_login().await;
        assert!(state.pending.lock().await.is_none());
    }

    #[tokio::test]
    async fn logout_wipes_store_and_pending_and_notifies() {
        let store = MemoryStore::default();
        store.save(&fixture_tokens()).unwrap();
        let state = build_state_with_store(store);
        let wakeup = state.wakeup.clone();
        let waiter = tokio::spawn(async move {
            wakeup.notified().await;
        });

        state.logout().await.unwrap();

        assert!(state.manager.peek_login().unwrap().is_none());
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("waiter should be woken")
            .expect("waiter task panicked");
    }

    #[tokio::test]
    async fn cancel_login_clears_pending_slot() {
        let state = build_state_with_store(MemoryStore::default());
        state.cancel_login().await;
        assert!(state.pending.lock().await.is_none());
    }
}
