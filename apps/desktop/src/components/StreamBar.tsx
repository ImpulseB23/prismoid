// One quiet line under the tabs: live marker with viewers and uptime, the
// category and the stream title.

import { Component, Show } from "solid-js";
import { formatUptime, formatViewers } from "../lib/streamInfo";
import { streamClock, streamInfo } from "../stores/streamStore";

const StreamBar: Component = () => {
  return (
    <Show when={streamInfo()}>
      {(s) => (
        <div class="stream-bar">
          <Show
            when={s().is_live}
            fallback={<span class="stream-bar__offline">Offline</span>}
          >
            <span class="stream-bar__live">Live</span>
            <span class="stream-bar__stat">
              {formatViewers(s().viewer_count ?? 0)} viewers
            </span>
            <Show when={s().started_at}>
              {(t) => (
                <span class="stream-bar__stat">
                  {formatUptime(t(), streamClock())}
                </span>
              )}
            </Show>
          </Show>
          <Show when={s().game_name}>
            <span class="stream-bar__game">{s().game_name}</span>
          </Show>
          <span class="stream-bar__title" title={s().title}>
            {s().title}
          </span>
        </div>
      )}
    </Show>
  );
};

export default StreamBar;
