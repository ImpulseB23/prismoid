// One quiet line under the tabs: live marker, category and stream title on
// the left, the numbers on the right (viewers, uptime, messages a minute,
// people chatting), each one switchable in Settings, and the button that
// shows a preview of the stream in the focused pane's corner. A channel loading for
// the first time gets a placeholder of the same height so nothing below it
// jumps.

import { Component, Show, onCleanup, onMount } from "solid-js";
import { formatUptime, formatViewers } from "../lib/streamInfo";
import { streamClock, streamInfo, streamLoading } from "../stores/streamStore";
import { activeChannel } from "../stores/channelStore";
import { settings } from "../stores/settingsStore";
import { focusedPaneId, panes, togglePaneVideo } from "../stores/layoutStore";
import {
  activeChatters,
  messagesPerMinute,
  startPulse,
} from "../stores/pulseStore";

const StreamBar: Component = () => {
  onMount(() => onCleanup(startPulse()));
  const videoOn = () =>
    panes().find((p) => p.id === focusedPaneId())?.video === true;

  return (
    <Show
      when={!streamLoading()}
      fallback={
        <div class="stream-bar stream-bar--loading" aria-hidden="true">
          <span class="skeleton skeleton--short" />
          <span class="skeleton skeleton--long" />
          <span class="skeleton skeleton--short stream-bar__skeleton-end" />
        </div>
      }
    >
      <Show when={streamInfo()}>
        {(s) => (
          // Keyed on the channel so a tab switch fades the bar in, while the
          // minute-by-minute refresh updates it in place.
          <Show when={activeChannel()?.id} keyed>
            {(channelId) => (
              <div class="stream-bar stream-bar--in">
                <Show
                  when={s().is_live}
                  fallback={<span class="stream-bar__offline">Offline</span>}
                >
                  <span class="stream-bar__live">Live</span>
                </Show>
                <Show when={s().game_name}>
                  <span class="stream-bar__game">{s().game_name}</span>
                </Show>
                <span class="stream-bar__title" title={s().title}>
                  {s().title}
                </span>

                <span class="stream-bar__stats">
                  <Show when={s().is_live && !settings().hideViewers}>
                    <span class="stream-bar__stat" title="Watching now">
                      {formatViewers(s().viewer_count ?? 0)} viewers
                    </span>
                  </Show>
                  <Show when={s().is_live && !settings().hideUptime}>
                    <Show when={s().started_at}>
                      {(t) => (
                        <span class="stream-bar__stat" title="Live for">
                          {formatUptime(t(), streamClock())}
                        </span>
                      )}
                    </Show>
                  </Show>
                  <Show when={!settings().hideChatRate}>
                    <span
                      class="stream-bar__stat"
                      title="Chat messages in the last minute"
                    >
                      {messagesPerMinute(channelId)} msg/min
                    </span>
                  </Show>
                  <Show when={!settings().hideChatters}>
                    <span
                      class="stream-bar__stat"
                      title="People who chatted in the last 5 minutes"
                    >
                      {activeChatters(channelId)} chatting
                    </span>
                  </Show>
                </span>
                <button
                  type="button"
                  class="stream-bar__video"
                  classList={{ "stream-bar__video--on": videoOn() }}
                  aria-pressed={videoOn()}
                  aria-label={
                    videoOn() ? "Hide the stream" : "Watch the stream"
                  }
                  title={videoOn() ? "Hide the stream" : "Watch the stream"}
                  onClick={() => togglePaneVideo(focusedPaneId())}
                >
                  <svg
                    width="16"
                    height="12"
                    viewBox="0 0 16 12"
                    aria-hidden="true"
                  >
                    <rect
                      x="0.75"
                      y="0.75"
                      width="10.5"
                      height="10.5"
                      rx="2"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    />
                    <path d="M12 4.5l3.25-2v7L12 7.5z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            )}
          </Show>
        )}
      </Show>
    </Show>
  );
};

export default StreamBar;
