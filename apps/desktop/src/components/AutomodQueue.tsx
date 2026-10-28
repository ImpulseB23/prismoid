// Messages AutoMod is holding in the open channel, newest first, with
// Allow and Deny. Whatever happens to one, by any mod or by Twitch letting
// it expire, shows on its row for a moment before it drops off.

import { Component, For, Show, createSignal } from "solid-js";
import { activeChannel } from "../stores/channelStore";
import { automodNeedsReconnect } from "../stores/authStore";
import {
  heldMessagesIn,
  resolveHeldMessage,
  type HeldEntry,
} from "../stores/automodStore";
import { manageHeldMessage, type SendMessageError } from "../lib/twitchAuth";
import { formatSendError, toSendError } from "../lib/messageInput";
import { formatTimestamp } from "../lib/messageStyle";
import type { HeldMessage } from "../lib/chatEvents";

export function heldReason(m: HeldMessage): string {
  switch (m.reason) {
    case "blocked_term":
      return "Blocked term";
    case "blocked_link":
      return "Blocked link";
  }
  const category = m.category || "AutoMod";
  return m.level === null ? category : `${category}, level ${m.level}`;
}

export function heldOutcome(e: HeldEntry): string {
  const by = e.by ? ` by ${e.by}` : "";
  switch (e.status) {
    case "approved":
      return `Allowed${by}`;
    case "denied":
      return `Denied${by}`;
    case "expired":
      return "Expired";
    case "pending":
      return "";
  }
}

const HeldRow: Component<{ entry: HeldEntry }> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const m = () => props.entry.message;

  const act = async (action: "ALLOW" | "DENY") => {
    const { channel_id, message_id } = m();
    setBusy(true);
    setError(null);
    try {
      await manageHeldMessage(channel_id, message_id, action);
      resolveHeldMessage({
        kind: "automod_resolved",
        channel_id,
        message_id,
        status: action === "ALLOW" ? "approved" : "denied",
        moderator_login: "",
        moderator_name: "",
      });
    } catch (raw) {
      const err = toSendError(raw);
      setError(
        typeof err === "string"
          ? err
          : formatSendError(err as SendMessageError),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      class="automod__row"
      classList={{
        "automod__row--done": props.entry.status !== "pending",
      }}
    >
      <div class="automod__meta">
        <span class="msg__time">{formatTimestamp(m().held_at)}</span>
        <span class="automod__user">{m().user_name || m().user_login}</span>
        <span class="automod__reason">{heldReason(m())}</span>
      </div>
      <div class="automod__text">{m().text}</div>
      <Show
        when={props.entry.status === "pending"}
        fallback={
          <div
            class="automod__outcome"
            classList={{
              "automod__outcome--denied": props.entry.status === "denied",
            }}
          >
            {heldOutcome(props.entry)}
          </div>
        }
      >
        <div class="automod__actions">
          <button
            type="button"
            class="modbar__more automod__allow"
            disabled={busy()}
            onClick={() => void act("ALLOW")}
          >
            Allow
          </button>
          <button
            type="button"
            class="modbar__more modbar__more--danger"
            disabled={busy()}
            onClick={() => void act("DENY")}
          >
            Deny
          </button>
          <Show when={error()}>
            {(msg) => (
              <span class="modbar__error" role="alert">
                {msg()}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </li>
  );
};

const AutomodQueue: Component = () => {
  const rows = () => {
    const id = activeChannel()?.id;
    return id === undefined ? [] : heldMessagesIn(id);
  };

  return (
    <div class="cc__body">
      <Show when={automodNeedsReconnect()}>
        <div class="dialog__error">
          Held messages need a new Twitch permission. Reconnect in Settings.
        </div>
      </Show>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="cc__empty">
            Nothing held right now. Messages AutoMod holds for review in this
            channel show up here.
          </div>
        }
      >
        <ol class="modlog__list">
          <For each={rows()}>{(entry) => <HeldRow entry={entry} />}</For>
        </ol>
      </Show>
    </div>
  );
};

export default AutomodQueue;
