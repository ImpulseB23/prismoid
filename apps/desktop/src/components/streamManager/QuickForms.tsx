// The two quick actions that need a few words first: a shoutout names a
// channel, an announcement needs its message. Each reports back through
// onDone so the grid can say what happened.

import { Component, For, Show, createSignal } from "solid-js";
import {
  QUICK_ACTION_LIMITS,
  sendAnnouncement,
  sendShoutout,
  type AnnouncementColor,
} from "../../lib/quickActions";
import {
  formatChannelError,
  lookupUser,
  normalizeLogin,
} from "../../lib/twitchChannel";

const COLORS: { id: AnnouncementColor; label: string }[] = [
  { id: "primary", label: "Your channel color" },
  { id: "blue", label: "Blue" },
  { id: "green", label: "Green" },
  { id: "orange", label: "Orange" },
  { id: "purple", label: "Purple" },
];

function useAction() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>(null);
  const run = async (call: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

const ActionError: Component<{ error: unknown }> = (props) => (
  <Show when={props.error}>
    <div class="dialog__error" role="alert">
      {formatChannelError(props.error)}
    </div>
  </Show>
);

export const ShoutoutForm: Component<{ onDone: (text: string) => void }> = (
  props,
) => {
  const [login, setLogin] = createSignal("");
  const action = useAction();

  const send = (e: SubmitEvent) => {
    e.preventDefault();
    const name = normalizeLogin(login());
    if (!name) return action.setError({ kind: "invalid_login" });
    void action.run(async () => {
      const user = await lookupUser(name);
      await sendShoutout(user.id);
      setLogin("");
      props.onDone(`Shoutout sent to ${user.display_name}.`);
    });
  };

  return (
    <form class="sm-qa-form" onSubmit={send}>
      <label class="sm-label" for="sm-shoutout">
        Channel to shout out
      </label>
      <div class="sm-inline">
        <input
          id="sm-shoutout"
          type="text"
          class="sm-input"
          placeholder="Their Twitch name"
          autocomplete="off"
          value={login()}
          onInput={(e) => setLogin(e.currentTarget.value)}
        />
        <button
          type="submit"
          class="btn btn--small btn--primary"
          disabled={action.busy() || !login().trim()}
        >
          Send shoutout
        </button>
      </div>
      <span class="sm-hint">
        Twitch allows one every 2 minutes, and the same channel once an hour.
      </span>
      <ActionError error={action.error()} />
    </form>
  );
};

export const AnnounceForm: Component<{ onDone: (text: string) => void }> = (
  props,
) => {
  const [message, setMessage] = createSignal("");
  const [color, setColor] = createSignal<AnnouncementColor>("primary");
  const action = useAction();
  const max = QUICK_ACTION_LIMITS.announcementChars;

  const send = (e: SubmitEvent) => {
    e.preventDefault();
    const text = message().trim();
    void action.run(async () => {
      await sendAnnouncement(text, color());
      setMessage("");
      props.onDone("Announcement sent.");
    });
  };

  return (
    <form class="sm-qa-form" onSubmit={send}>
      <label class="sm-label" for="sm-announce">
        Announcement
        <span class="sm-label__aside">{max - message().length} left</span>
      </label>
      <textarea
        id="sm-announce"
        class="sm-input sm-input--area"
        rows="2"
        maxLength={max}
        value={message()}
        onInput={(e) => setMessage(e.currentTarget.value)}
      />
      <div class="sm-inline">
        <label class="sm-sr" for="sm-announce-color">
          Color
        </label>
        <select
          id="sm-announce-color"
          class="sm-input"
          onChange={(e) => setColor(e.currentTarget.value as AnnouncementColor)}
        >
          <For each={COLORS}>
            {(c) => (
              <option value={c.id} selected={c.id === color()}>
                {c.label}
              </option>
            )}
          </For>
        </select>
        <button
          type="submit"
          class="btn btn--small btn--primary"
          disabled={action.busy() || !message().trim()}
        >
          Send announcement
        </button>
      </div>
      <ActionError error={action.error()} />
    </form>
  );
};
