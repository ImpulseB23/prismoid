// Live or offline, uptime and viewers for the user's own channel, in the
// stream manager's title bar. Polls like the stream bar does.

import { Component, Show, createSignal, onCleanup } from "solid-js";
import { createStreamStore } from "../../stores/streamStore";
import { formatUptime, formatViewers } from "../../lib/streamInfo";

const LiveStatus: Component<{ userId: string }> = (props) => {
  const stream = createStreamStore();
  stream.track(() => props.userId);

  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  return (
    <Show when={stream.info()} keyed>
      {(info) => (
        <span
          class="sm-live"
          classList={{ "sm-live--on": info.is_live }}
          data-tauri-drag-region
        >
          <Show when={info.is_live} fallback="Offline">
            <span class="sm-live__dot" aria-hidden="true" />
            Live
            {info.started_at !== null ? (
              <span>{formatUptime(info.started_at, now())}</span>
            ) : null}
            {info.viewer_count !== null ? (
              <span>{formatViewers(info.viewer_count)} watching</span>
            ) : null}
          </Show>
        </span>
      )}
    </Show>
  );
};

export default LiveStatus;
