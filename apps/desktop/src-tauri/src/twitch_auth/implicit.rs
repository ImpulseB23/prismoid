//! Twitch sign-in through the implicit grant on a loopback relay (ADR 43).
//!
//! Twitch returns the token in the URL fragment of the registered
//! redirect. Fragments never reach a server, so the loopback server first
//! answers with a page whose script posts the fragment back, then replies
//! with the done page while the pending login resolves. The ports are
//! fixed because Twitch only redirects to URLs registered on the
//! application.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use twitch_oauth2::tokens::errors::ImplicitUserTokenExchangeError;
use twitch_oauth2::tokens::ImplicitUserTokenBuilder;
use twitch_oauth2::url::{form_urlencoded, Url};
use twitch_oauth2::{ClientId, Scope, UserToken};

use super::errors::{error_chain, AuthError};

/// Redirect ports registered on the Twitch application, tried in order.
/// Twitch matches the redirect character for character and the URL type
/// always carries the trailing slash, so the registered entries are
/// `http://localhost:21337/` and `http://localhost:21338/`.
pub const LOGIN_PORTS: [u16; 2] = [21337, 21338];
/// How long the browser gets before the pending login gives up.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_REQUEST_BYTES: usize = 16 * 1024;

const RELAY_PAGE: &str = include_str!("relay_page.html");
// Same page the YouTube loopback shows; it says nothing provider specific.
const DONE_PAGE: &str = include_str!("../oauth_pkce/success_page.html");

/// A sign-in that has opened the browser and is waiting for Twitch's
/// redirect. Consumed by [`PendingLogin::wait`]; dropping it closes the
/// listeners so the port is free for the next attempt.
pub struct PendingLogin {
    v4: TcpListener,
    v6: Option<TcpListener>,
    builder: ImplicitUserTokenBuilder,
}

impl PendingLogin {
    pub async fn start(client_id: ClientId, scopes: Vec<Scope>) -> Result<(Self, Url), AuthError> {
        Self::start_on(&LOGIN_PORTS, client_id, scopes).await
    }

    async fn start_on(
        ports: &[u16],
        client_id: ClientId,
        scopes: Vec<Scope>,
    ) -> Result<(Self, Url), AuthError> {
        let (v4, v6) = bind_loopback(ports).await?;
        let port = v4.local_addr().map_err(AuthError::Loopback)?.port();
        let redirect =
            Url::parse(&format!("http://localhost:{port}")).expect("loopback url is well formed");
        let mut builder = ImplicitUserTokenBuilder::new(client_id, redirect).set_scopes(scopes);
        let (authorize_url, _csrf) = builder.generate_url();
        Ok((Self { v4, v6, builder }, authorize_url))
    }

    /// Serves the relay until Twitch's answer arrives, the browser stays
    /// silent past [`LOGIN_TIMEOUT`], or `cancel` fires.
    pub async fn wait(
        self,
        http: &reqwest::Client,
        cancel: &Notify,
    ) -> Result<UserToken, AuthError> {
        tokio::select! {
            served = tokio::time::timeout(LOGIN_TIMEOUT, self.serve(http)) => {
                served.unwrap_or(Err(AuthError::LoginTimedOut))
            }
            () = cancel.notified() => Err(AuthError::LoginCancelled),
        }
    }

    async fn serve(self, http: &reqwest::Client) -> Result<UserToken, AuthError> {
        let Self {
            v4, v6, builder, ..
        } = self;
        loop {
            let mut stream = accept_any(&v4, v6.as_ref())
                .await
                .map_err(AuthError::Loopback)?;
            let Some(request) = read_request(&mut stream)
                .await
                .map_err(AuthError::Loopback)?
            else {
                respond(&mut stream, 400, "text/plain", "bad request").await;
                continue;
            };
            let params = match route(&request) {
                Route::Relay => {
                    respond(&mut stream, 200, "text/html; charset=utf-8", RELAY_PAGE).await;
                    continue;
                }
                Route::NotFound => {
                    respond(&mut stream, 404, "text/plain", "not found").await;
                    continue;
                }
                Route::Callback(params) => params,
            };
            // A request carrying someone else's state is not Twitch's
            // answer to this login; keep waiting for the real one.
            if !params
                .state
                .as_deref()
                .is_some_and(|s| builder.csrf_is_valid(s))
            {
                respond(&mut stream, 400, "text/plain", "state mismatch").await;
                continue;
            }
            let exchanged = builder
                .get_user_token(
                    http,
                    params.state.as_deref(),
                    params.access_token.as_deref(),
                    params.error.as_deref(),
                    params.error_description.as_deref(),
                )
                .await;
            return match exchanged {
                Ok(token) => {
                    respond(&mut stream, 200, "text/html; charset=utf-8", DONE_PAGE).await;
                    Ok(token)
                }
                Err(e) => {
                    let err = classify_exchange_error(e);
                    respond(&mut stream, 400, "text/plain", &err.to_string()).await;
                    Err(err)
                }
            };
        }
    }
}

// Browsers resolve localhost to both loopback addresses, so a port only
// counts as ours when nobody else holds its IPv6 side either. Hosts
// without IPv6 simply get the IPv4 listener.
async fn bind_loopback(ports: &[u16]) -> Result<(TcpListener, Option<TcpListener>), AuthError> {
    for &port in ports {
        let Ok(v4) =
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)).await
        else {
            continue;
        };
        let bound = v4.local_addr().map_err(AuthError::Loopback)?.port();
        match TcpListener::bind(SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), bound)).await {
            Ok(v6) => return Ok((v4, Some(v6))),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(_) => return Ok((v4, None)),
        }
    }
    Err(AuthError::LoginPortsBusy)
}

async fn accept_any(v4: &TcpListener, v6: Option<&TcpListener>) -> std::io::Result<TcpStream> {
    match v6 {
        Some(v6) => tokio::select! {
            accepted = v4.accept() => accepted.map(|(s, _)| s),
            accepted = v6.accept() => accepted.map(|(s, _)| s),
        },
        None => v4.accept().await.map(|(s, _)| s),
    }
}

struct Request {
    method: String,
    target: String,
    body: Vec<u8>,
}

// Reads one HTTP/1.1 request: head up to the blank line, then as many
// body bytes as Content-Length announces, capped. Malformed input gives
// `None` so the caller can answer 400 and keep serving.
async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() >= MAX_REQUEST_BYTES {
            return Ok(None);
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let Ok(head) = std::str::from_utf8(&buf[..head_end]) else {
        return Ok(None);
    };
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target)) = (request_line.next(), request_line.next()) else {
        return Ok(None);
    };
    let content_length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_REQUEST_BYTES {
        return Ok(None);
    }

    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);

    Ok(Some(Request {
        method: method.to_owned(),
        target: target.to_owned(),
        body,
    }))
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CallbackParams {
    access_token: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

impl CallbackParams {
    fn parse(encoded: &[u8]) -> Self {
        let mut params = Self::default();
        for (k, v) in form_urlencoded::parse(encoded) {
            let v = v.into_owned();
            match &*k {
                "access_token" => params.access_token = Some(v),
                "state" => params.state = Some(v),
                "error" => params.error = Some(v),
                "error_description" => params.error_description = Some(v),
                _ => {}
            }
        }
        params
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Relay,
    Callback(CallbackParams),
    NotFound,
}

// Twitch sends a granted token in the fragment, which the relay page posts
// to /callback, but a declined authorization comes back in the query of
// the redirect itself.
fn route(request: &Request) -> Route {
    let (path, query) = match request.target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (request.target.as_str(), None),
    };
    match (request.method.as_str(), path, query) {
        ("GET", "/", Some(q)) => {
            let params = CallbackParams::parse(q.as_bytes());
            if params.error.is_some() {
                Route::Callback(params)
            } else {
                Route::Relay
            }
        }
        ("GET", "/", None) => Route::Relay,
        ("POST", "/callback", _) => Route::Callback(CallbackParams::parse(&request.body)),
        _ => Route::NotFound,
    }
}

async fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    // The browser closing early is not worth failing the login over.
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
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

    async fn start() -> (PendingLogin, Url) {
        PendingLogin::start_on(
            &[0],
            ClientId::new("client".into()),
            vec![Scope::UserReadChat],
        )
        .await
        .expect("ephemeral port binds")
    }

    async fn roundtrip(addr: SocketAddr, request: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.expect("read");
        String::from_utf8(out).expect("utf8 response")
    }

    #[test]
    fn route_tells_relay_callback_and_errors_apart() {
        let get = |target: &str| Request {
            method: "GET".into(),
            target: target.into(),
            body: Vec::new(),
        };
        assert_eq!(route(&get("/")), Route::Relay);
        assert_eq!(route(&get("/?foo=bar")), Route::Relay);
        assert_eq!(route(&get("/favicon.ico")), Route::NotFound);
        match route(&get(
            "/?error=access_denied&error_description=The+user+denied+you+access&state=abc",
        )) {
            Route::Callback(p) => {
                assert_eq!(p.error.as_deref(), Some("access_denied"));
                assert_eq!(
                    p.error_description.as_deref(),
                    Some("The user denied you access")
                );
                assert_eq!(p.state.as_deref(), Some("abc"));
            }
            other => panic!("expected callback, got {other:?}"),
        }
        let post = Request {
            method: "POST".into(),
            target: "/callback".into(),
            body: b"access_token=tok%2B1&scope=user%3Aread%3Achat&state=xyz&token_type=bearer"
                .to_vec(),
        };
        match route(&post) {
            Route::Callback(p) => {
                assert_eq!(p.access_token.as_deref(), Some("tok+1"));
                assert_eq!(p.state.as_deref(), Some("xyz"));
                assert!(p.error.is_none());
            }
            other => panic!("expected callback, got {other:?}"),
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
    async fn authorize_url_targets_twitch_with_the_loopback_redirect() {
        let (pending, url) = start().await;
        let port = pending.v4.local_addr().unwrap().port();
        assert_eq!(url.host_str(), Some("id.twitch.tv"));
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["response_type"], "token");
        assert_eq!(pairs["redirect_uri"], format!("http://localhost:{port}/"));
        assert_eq!(pairs["scope"], "user:read:chat");
        assert!(pending.builder.csrf_is_valid(&pairs["state"]));
    }

    #[tokio::test]
    async fn relay_is_served_bad_state_is_ignored_and_cancel_ends_the_wait() {
        let (pending, _) = start().await;
        let addr = pending.v4.local_addr().unwrap();
        let cancel = std::sync::Arc::new(Notify::new());
        let waiter = {
            let cancel = cancel.clone();
            tokio::spawn(async move { pending.wait(&http(), &cancel).await })
        };

        let relay = roundtrip(addr, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
        assert!(relay.starts_with("HTTP/1.1 200 OK"));
        assert!(relay.contains("/callback"), "relay page posts the fragment");

        let body = "access_token=abc&state=not-ours";
        let forged = roundtrip(
            addr,
            &format!(
                "POST /callback HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(forged.starts_with("HTTP/1.1 400"), "{forged}");

        let missing = roundtrip(addr, "GET /favicon.ico HTTP/1.1\r\nHost: localhost\r\n\r\n").await;
        assert!(missing.starts_with("HTTP/1.1 404"));

        cancel.notify_waiters();
        let result = waiter.await.expect("task");
        assert!(
            matches!(result, Err(AuthError::LoginCancelled)),
            "{result:?}"
        );
        assert!(
            TcpStream::connect(addr).await.is_err(),
            "listener closes with the login"
        );
    }

    #[tokio::test]
    async fn declined_authorization_ends_the_login() {
        let (pending, url) = start().await;
        let addr = pending.v4.local_addr().unwrap();
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .expect("authorize url carries the state");
        let cancel = Notify::new();
        let waiter = tokio::spawn(async move { pending.wait(&http(), &cancel).await });

        // Encoded the way Twitch builds the redirect, since the state can
        // hold characters a bare query would mangle.
        let query = form_urlencoded::Serializer::new(String::new())
            .append_pair("error", "access_denied")
            .append_pair("error_description", "The user denied you access")
            .append_pair("state", &state)
            .finish();
        let response = roundtrip(
            addr,
            &format!("GET /?{query} HTTP/1.1\r\nHost: localhost\r\n\r\n"),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        let result = waiter.await.expect("task");
        assert!(matches!(result, Err(AuthError::UserDenied)), "{result:?}");
    }

    #[tokio::test]
    async fn busy_ports_are_reported() {
        let holder = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = holder.local_addr().unwrap().port();
        let result =
            PendingLogin::start_on(&[port], ClientId::new("client".into()), Vec::new()).await;
        assert!(matches!(result, Err(AuthError::LoginPortsBusy)));
    }
}
