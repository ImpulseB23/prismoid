//! Error type shared across the twitch_auth module.
//!
//! Each variant corresponds to a real decision branch a caller needs to
//! make (re-auth UI per ADR 31, retry, surface to the user). Don't add
//! variants unless the caller cares about the distinction.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AuthError {
    /// No tokens have been persisted. Supervisor's correct response is
    /// to kick off the device flow (or idle for the frontend to do so).
    #[error("no tokens stored")]
    NoTokens,

    /// Refresh exchange succeeded with the server but the server said the
    /// refresh token is invalid. Per ADR 31 this surfaces a re-auth UI;
    /// do not retry with the same refresh token.
    #[error("refresh token rejected; user must re-authenticate")]
    RefreshTokenInvalid,

    /// The browser never answered within the login window. The caller
    /// should start a new flow.
    #[error("no answer from the browser within ten minutes")]
    LoginTimedOut,

    /// `twitch_cancel_login` ran while a login was waiting.
    #[error("sign-in cancelled")]
    LoginCancelled,

    /// User declined the authorization request on Twitch.
    #[error("the Twitch authorization was declined")]
    UserDenied,

    /// Keyring / OS credential store error. Typically means the user
    /// cancelled a prompt or the credential service is unavailable.
    #[error(transparent)]
    Keychain(#[from] keyring::Error),

    /// Any other error from the OAuth stack (HTTP, URL parse, token
    /// response decode, etc.). Callers that need finer-grained handling
    /// can match on `self.source()`.
    #[error("oauth2 stack error: {0}")]
    OAuth(String),

    /// JSON (de)serialization of the persisted token blob failed.
    #[error(transparent)]
    Json(#[from] serde_json::Error),

    /// Configuration error during AuthManager construction (malformed
    /// URL, empty client id, etc.). Bug, not a runtime condition.
    #[error("configuration error: {0}")]
    Config(String),

    /// The frontend named a scope group the host does not define.
    #[error("unknown scope group: {0}")]
    UnknownScopeGroup(String),

    /// Saving the enabled scope groups to disk failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

// The twitch_oauth2 Displays stop at the outer variant ("creation of
// token failed"); the useful part sits in the source chain.
pub(super) fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut cur = err.source();
    while let Some(e) = cur {
        out.push_str(": ");
        out.push_str(&e.to_string());
        cur = e.source();
    }
    out
}
