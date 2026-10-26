import { Component, Show, createSignal, onMount } from "solid-js";
import {
  cancelLogin,
  completeLogin,
  openVerificationUri,
  startLogin,
  type AuthCommandError,
  type AuthStatus,
  type DeviceCodeView,
} from "../lib/twitchAuth";
import logo from "../assets/logo.svg";

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
  const [pending, setPending] = createSignal<DeviceCodeView | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Tauri commands have no cancellation token, so an in-flight
  // completeLogin() Promise keeps polling Twitch even after the user
  // hits "Start over". The generation counter lets us ignore stale
  // resolutions/rejections from the previous attempt.
  let generation = 0;

  onMount(() => {
    void cancelLogin().catch(() => {});
  });

  const beginFlow = async () => {
    generation += 1;
    const gen = generation;
    setError(null);
    setBusy(true);
    try {
      const details = await startLogin();
      if (gen !== generation) return;
      setPending(details);
      void openVerificationUri(details.verification_uri).catch(() => {});

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

  const startOver = async () => {
    generation += 1;
    setPending(null);
    setBusy(false);
    setError(null);
    await cancelLogin().catch(() => {});
  };

  return (
    <div class="signin">
      <img class="signin__logo" src={logo} alt="" />
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
          <div class="code-card">
            <p>
              A browser tab opened. Check the code matches, then choose
              Authorize.
            </p>
            <code>{p().user_code}</code>
            <small>
              No browser?{" "}
              <a
                href={p().verification_uri}
                onClick={(e) => {
                  e.preventDefault();
                  void openVerificationUri(p().verification_uri).catch(
                    () => {},
                  );
                }}
              >
                {p().verification_uri}
              </a>
            </small>
            <button type="button" class="btn btn--outline" onClick={startOver}>
              Start over
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
      return "Authorization was denied. Try again to grant access.";
    case "device_code_expired":
      return "The code expired before you confirmed. Try again.";
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
