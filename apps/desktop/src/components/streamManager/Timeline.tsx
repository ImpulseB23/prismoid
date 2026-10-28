// The stream so far as one rail: elapsed time in the prism gradient, the
// events this window knows about where they happened, a line for now and
// the next ad ahead of it. Positions are percentages of the visible span,
// which runs from the stream start to a little past now or the next ad.

import { Component, For, Show, createMemo } from "solid-js";
import { formatAdLength, formatTime } from "../../lib/streamInfo";
import type { LogEntry } from "../../stores/streamLogStore";

const LOOKAHEAD_MS = 10 * 60_000;
// Labels closer than this, in percent of the rail, would overlap.
const LABEL_GAP = 14;

export interface NextAd {
  at: number;
  secs: number;
}

function describe(e: LogEntry): string {
  switch (e.kind) {
    case "ad":
      return `Ad break, ${formatAdLength(e.ad.duration_seconds)}`;
    case "marker":
      return e.marker.description
        ? `Marker: ${e.marker.description}`
        : "Marker";
    case "poll":
      return "Poll ended";
    case "prediction":
      return "Prediction ended";
  }
}

const Timeline: Component<{
  start: number;
  now: number;
  entries: LogEntry[];
  nextAd: NextAd | null;
}> = (props) => {
  const upcoming = () => {
    const next = props.nextAd;
    return next && next.at > props.now ? next : null;
  };

  const end = () => {
    const elapsed = props.now - props.start;
    const ahead = props.now + Math.max(elapsed * 0.15, LOOKAHEAD_MS);
    const next = upcoming();
    return next ? Math.max(ahead, next.at + next.secs * 1000 + 60_000) : ahead;
  };

  const pct = (t: number) =>
    Math.min(
      100,
      Math.max(0, ((t - props.start) / (end() - props.start)) * 100),
    );

  const seen = () =>
    props.entries.filter((e) => e.at >= props.start && e.at <= props.now);

  // Start, now and the next ad always get a label; events get one where
  // it fits between the others.
  const labelled = createMemo(() => {
    const taken = [0, pct(props.now)];
    const next = upcoming();
    if (next) taken.push(pct(next.at));
    const out = new Set<LogEntry>();
    for (const e of seen()) {
      const at = pct(e.at);
      if (taken.every((t) => Math.abs(t - at) >= LABEL_GAP)) {
        taken.push(at);
        out.add(e);
      }
    }
    return out;
  });

  const place = (at: number) => ({
    left: `${at}%`,
    transform: `translateX(-${at}%)`,
  });

  return (
    <div class="sm-rail">
      <div class="sm-rail__bar" aria-hidden="true">
        <div class="sm-rail__track" />
        <div class="sm-rail__elapsed" style={{ width: `${pct(props.now)}%` }} />
        <For each={seen()}>
          {(e) =>
            e.kind === "ad" ? (
              <div
                class="sm-rail__ad"
                title={describe(e)}
                style={{
                  left: `${pct(e.at)}%`,
                  width: `${pct(e.at + e.ad.duration_seconds * 1000) - pct(e.at)}%`,
                }}
              />
            ) : (
              <div
                class="sm-rail__tick"
                title={describe(e)}
                style={{ left: `${pct(e.at)}%` }}
              />
            )
          }
        </For>
        <div class="sm-rail__now" style={{ left: `${pct(props.now)}%` }} />
        <Show when={upcoming()}>
          {(next) => (
            <div
              class="sm-rail__next"
              title={`Next ad, ${formatAdLength(next().secs)}`}
              style={{
                left: `${pct(next().at)}%`,
                width: `${pct(next().at + next().secs * 1000) - pct(next().at)}%`,
              }}
            />
          )}
        </Show>
      </div>
      <div class="sm-rail__labels" aria-hidden="true">
        <span class="sm-rail__label" style={place(0)}>
          Started {formatTime(props.start)}
        </span>
        <For each={seen()}>
          {(e) => (
            <Show when={labelled().has(e)}>
              <span class="sm-rail__label" style={place(pct(e.at))}>
                {e.kind === "ad" ? "Ad break" : describe(e)}
              </span>
            </Show>
          )}
        </For>
        <span
          class="sm-rail__label sm-rail__label--now"
          style={place(pct(props.now))}
        >
          Now
        </span>
        <Show when={upcoming()}>
          {(next) => (
            <span
              class="sm-rail__label sm-rail__label--ad"
              style={place(pct(next().at))}
            >
              Next ad
            </span>
          )}
        </Show>
      </div>
      <ol class="sm-sr" aria-label="Stream timeline">
        <li>Started at {formatTime(props.start)}</li>
        <For each={seen()}>
          {(e) => (
            <li>
              {describe(e)} at {formatTime(e.at)}
            </li>
          )}
        </For>
        <Show when={upcoming()}>
          {(next) => (
            <li>
              Next ad, {formatAdLength(next().secs)}, at {formatTime(next().at)}
            </li>
          )}
        </Show>
      </ol>
    </div>
  );
};

export default Timeline;
