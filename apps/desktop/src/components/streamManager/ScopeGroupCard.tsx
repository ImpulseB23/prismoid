// Stands in for a stream manager feature whose Twitch permissions are
// opt-in: says what turning it on allows, turns it on, and then walks
// through the reconnect Twitch needs to grant the new access.

import { Component, Show, createSignal } from "solid-js";
import {
  disableScopeGroup,
  enableScopeGroup,
  type ScopeGroup,
} from "../../lib/twitchAuth";
import {
  scopeGroupEnabled,
  scopeGroupNeedsReconnect,
  setAuthStatus,
} from "../../stores/authStore";
import TwitchReconnect from "../TwitchReconnect";
import { authErrorMessage, isAuthError } from "../SignIn";

const COPY: Record<ScopeGroup, { title: string; body: string }> = {
  stream: {
    title: "Manage your stream from here",
    body: "Change your title, category and tags, add markers, and run polls and predictions. Prismoid asks Twitch for access to your channel once you turn this on.",
  },
  ads: {
    title: "Run your ads from here",
    body: "See when the next ad comes, snooze it, and start a break when it suits you. Prismoid asks Twitch for access to your ads once you turn this on.",
  },
  live_actions: {
    title: "Clips, shoutouts and more",
    body: "Make clips, send shoutouts and announcements, and switch on Shield Mode from here. Prismoid asks Twitch for these once you turn them on.",
  },
};

const ScopeGroupCard: Component<{ group: ScopeGroup }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const change = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const call = on ? enableScopeGroup : disableScopeGroup;
      setAuthStatus(await call(props.group));
    } catch (e) {
      setError(
        isAuthError(e)
          ? authErrorMessage(e)
          : "Prismoid could not save that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sm-card sm-opt-in">
      <Show
        when={scopeGroupEnabled(props.group)}
        fallback={
          <>
            <div class="sm-opt-in__text">
              <span class="sm-card__title">{COPY[props.group].title}</span>
              <span class="sm-hint">{COPY[props.group].body}</span>
            </div>
            <button
              type="button"
              class="btn btn--small btn--primary"
              disabled={busy()}
              onClick={() => void change(true)}
            >
              Turn on
            </button>
          </>
        }
      >
        <Show when={scopeGroupNeedsReconnect(props.group)}>
          <TwitchReconnect
            title="One more step on Twitch"
            hint="Reconnect so Twitch can grant the new access."
          />
          <button
            type="button"
            class="btn btn--small"
            disabled={busy()}
            onClick={() => void change(false)}
          >
            Turn it off again
          </button>
        </Show>
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

export default ScopeGroupCard;
