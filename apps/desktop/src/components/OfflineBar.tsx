// Above the composer of a chat whose stream ended: how long until it
// closes, a way to keep it, and, when the channel raided, a way to follow.

import { Component, Show } from "solid-js";
import type { Channel } from "../lib/twitchChannel";
import { closeChannel, selectChannel } from "../stores/channelStore";
import {
  keepEndedChatOpen,
  offlineRaidOf,
  offlineSecondsLeft,
} from "../stores/offlineStore";

const report = (what: string) => (err: unknown) => console.error(what, err);

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const OfflineBar: Component<{ channel: Channel | null }> = (props) => (
  <Show
    when={(() => {
      const c = props.channel;
      if (!c) return null;
      const left = offlineSecondsLeft(c.id);
      return left === null ? null : { channel: c, left };
    })()}
  >
    {(s) => (
      <div class="offline-bar" role="status">
        <span class="offline-bar__text">
          Stream ended. Closing in {formatCountdown(s().left)}
        </span>
        <Show when={offlineRaidOf(s().channel.id)}>
          {(raid) => (
            <button
              type="button"
              class="btn btn--small btn--primary"
              onClick={() => {
                const ended = s().channel.id;
                void selectChannel(raid().login, { remember: true })
                  .then(() => closeChannel(ended))
                  .catch(report("follow raid"));
              }}
            >
              Go to {raid().name}
            </button>
          )}
        </Show>
        <button
          type="button"
          class="btn btn--small btn--outline"
          onClick={() => keepEndedChatOpen(s().channel.id)}
        >
          Keep open
        </button>
      </div>
    )}
  </Show>
);

export default OfflineBar;
