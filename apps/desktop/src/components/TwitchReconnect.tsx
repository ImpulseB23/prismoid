// Runs the Twitch sign-in again when the stored grant predates a scope the
// app now needs. The existing tokens stay in place until Twitch hands back
// the new ones, so cancelling costs nothing.

import { Component, Show, createSignal, onCleanup } from "solid-js";
import {
  cancelLogin,
  completeLogin,
  openTwitchUrl,
  startLogin,
  type LoginView,
} from "../lib/twitchAuth";
import { setAuthStatus } from "../stores/authStore";
import { authErrorMessage, isAuthError } from "./SignIn";

const TwitchReconnect: Component<{
  title: string;
  hint: string;
  /** Carries the Settings attention marker. */
  marked?: boolean;
}> = (props) => {
  const [pending, setPending] = createSignal<LoginView | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let generation = 0;

  const openTwitch = (url: string) =>
    openTwitchUrl(url).catch((err: unknown) => {
      console.error("open twitch", err);
      setError(`Your browser did not open. Copy this link into it: ${url}`);
    });

  const begin = async () => {
    const gen = ++generation;
    setError(null);
    setBusy(true);
    try {
      const view = await startLogin();
      if (gen !== generation) return;
      setPending(view);
      openTwitch(view.authorize_url);
      const status = await completeLogin();
      if (gen !== generation) return;
      setAuthStatus(status);
    } catch (e) {
      if (gen !== generation) return;
      setError(
        isAuthError(e)
          ? authErrorMessage(e)
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      if (gen === generation) {
        setBusy(false);
        setPending(null);
      }
    }
  };

  const cancel = () => {
    generation++;
    setPending(null);
    setBusy(false);
    void cancelLogin().catch((err: unknown) =>
      console.error("cancel reconnect", err),
    );
  };

  onCleanup(() => {
    if (busy()) cancel();
  });

  return (
    <div
      class="settings__row settings__row--stack settings__reconnect"
      classList={{ "settings__row--attention": props.marked === true }}
    >
      <div class="settings__text">
        <span class="settings__name">{props.title}</span>
        <span class="settings__hint">{props.hint}</span>
      </div>
      <Show
        when={pending()}
        fallback={
          <button
            type="button"
            class="btn btn--primary"
            disabled={busy()}
            onClick={() => void begin()}
          >
            Reconnect Twitch
          </button>
        }
      >
        {(p) => (
          <div class="settings__reconnect-wait">
            <span class="settings__hint">
              Choose Authorize in the browser tab that opened, then let it open
              prismoid.{" "}
              <a
                href={p().authorize_url}
                onClick={(e) => {
                  e.preventDefault();
                  openTwitch(p().authorize_url);
                }}
              >
                Open it again
              </a>
            </span>
            <button type="button" class="btn btn--outline" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {e()}
          </div>
        )}
      </Show>
    </div>
  );
};

export default TwitchReconnect;
