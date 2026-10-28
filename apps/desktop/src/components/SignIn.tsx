import { Component, Show, createSignal, onMount } from "solid-js";
import {
  cancelLogin,
  completeLogin,
  openTwitchUrl,
  startLogin,
  type AuthCommandError,
  type AuthStatus,
  type LoginView,
} from "../lib/twitchAuth";
import { logo } from "../stores/themeStore";

export interface SignInProps {
  onAuthenticated: (status: AuthStatus) => void;
}

export function isAuthError(e: unknown): e is AuthCommandError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

const SignIn: Component<SignInProps> = (props) => {
  const [pending, setPending] = createSignal<LoginView | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [browserFailed, setBrowserFailed] = createSignal(false);
  // Cancelling tells the host| null>(null);
  // Cancelling tells the host to stop listening, but the in-flight
  // completeLogin() Promise still settles. The generation counter lets us
  // ignore that stale result.
  let generation = 0;

  onMount(() => {
    void cancelLogin().catch((err: unknown) =>
      console.error("cancel stale sign-in", err),
    );
  });

  const openTwitch = (url: string) => {
    setBrowserFailed(false);
    openTwitchUrl(url).catch((err: unknown) => {
      console.error("open twitch", err);
      setBrowserFailed(true);
    });
  };

  const beginFlow = async () => {
    generation += 1;
    const gen = generation;
    setError(null);
    setBusy(true);
    try {
      const view = await startLogin();
      if (gen !== generation) return;
      setPending(view);
      openTwitch(view.authorize_url);

      const status = await completeLogin();
      if (gen !== generation) return;
      if (status.state === "logged_in" && status.login) {
        props.onAuthenticated(status);
      } else {
        setError("Sign-in returned without a login. Please try again.");
      }
    } catch (e) {
      if (gen !== generation) return;
      if (isAuthError(e)) {
        setError(authErrorMessage(e));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (gen === generation) {
        setBusy(false);
        setPending(null);
      }
    }
  };

  const cancel = async () => {
    generation += 1;
    setPending(null);
    setBusy(false);
    setError(null);
    setBrowserFailed(false);
    await cancelLogin().catch((err: unknown) =>
      console.error("cancel sign-in", err),
    );
  };

  return (
    <div class="signin">
      <img class="signin__logo" src={logo()} alt="" />
      <h1>
        prismoid<span>.</span>
      </h1>
      <p class="signin__lede">
        Any Twitch chat in one clean window, with 7TV, BTTV and FFZ emotes.
        Twitch handles the sign-in in your browser; prismoid never sees your
        password.
      </p>
      <Show
        when={pending()}
        fallback={
          <button
            type="button"
            class="btn btn--primary"
            onClick={beginFlow}
            disabled={busy()}
          >
            Sign in with Twitch
          </button>
        }
      >
        {(p) => (
          <div class="waiting-card">
            <p>
              A browser tab opened. Choose Authorize there, let the browser open
              prismoid, and this window carries on by itself.
            </p>
            <small>
              Nothing opened?{" "}
              <a
                href={p().authorize_url}
                onClick={(e) => {
                  e.preventDefault();
                  openTwitch(p().authorize_url);
                }}
              >
                Open Twitch again
              </a>
            </small>
            <Show when={browserFailed()}>
              <div class="signin__manual" role="alert">
                <span>Your browser did not open. Copy this link into it:</span>
                <input
                  type="text"
                  readOnly
                  value={p().authorize_url}
                  aria-label="Twitch sign-in link"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
            </Show>
            <button type="button" class="btn btn--outline" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(e) => (
          <p class="signin__error" role="alert">
            {e()}
          </p>
        )}
      </Show>
    </div>
  );
};

export function authErrorMessage(e: AuthCommandError): string {
  switch (e.kind) {
    case "user_denied":
      return "Authorization was declined. Try again to grant access.";
    case "login_timed_out":
      return "Twitch did not answer within ten minutes. Try again.";
    case "login_cancelled":
      return "Sign-in was cancelled.";
    case "keychain":
      return `Could not access the OS credential store: ${e.message}`;
    case "oauth":
      return `Twitch rejected the request: ${e.message}`;
    case "no_pending_flow":
      return "Sign-in flow lost its state. Try again.";
    default:
      return e.message;
  }
}

export default SignIn;
