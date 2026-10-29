// The poll or prediction running on the user's channel, with live bars and
// the controls to end it. Shows nothing while neither runs.

import { Component, For, Show, createSignal } from "solid-js";
import type { Poll, Prediction } from "../../lib/streamManager";
import { formatClock, formatViewers } from "../../lib/streamInfo";
import { formatChannelError } from "../../lib/twitchChannel";
import { createConfirmTap } from "../../lib/confirmTap";
import {
  cancelPrediction,
  currentPoll,
  currentPrediction,
  endPoll,
  lockPrediction,
  pollError,
  pollPending,
  predictionError,
  predictionPending,
  resolvePrediction,
} from "../../stores/streamManagerStore";

const share = (part: number, total: number) =>
  total > 0 ? Math.round((part / total) * 100) : 0;

const Bar: Component<{
  label: string;
  detail: string;
  pct: number;
  tone?: "blue" | "pink";
}> = (props) => (
  <div class="sm-bar">
    <span class="sm-bar__text">
      <span>{props.label}</span>
      <span>{props.detail}</span>
    </span>
    <div
      class="sm-bar__track"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.pct}
    >
      <i
        classList={{
          "sm-bar__fill": true,
          [`sm-bar__fill--${props.tone}`]: props.tone !== undefined,
        }}
        style={{ width: `${props.pct}%` }}
      />
    </div>
  </div>
);

const PollCard: Component<{ poll: Poll; now: number }> = (props) => {
  const total = () => props.poll.choices.reduce((n, c) => n + c.votes, 0);
  const left = () =>
    props.poll.ends_at === null ? null : props.poll.ends_at - props.now;
  return (
    <div class="sm-running">
      <div class="sm-running__head">
        <span class="sm-running__kind">Poll running</span>
        <span class="sm-hint">
          <Show when={left()}>{(l) => `${formatClock(l())} left, `}</Show>
          {total().toLocaleString()} {total() === 1 ? "vote" : "votes"}
        </span>
      </div>
      <span class="sm-running__title">{props.poll.title}</span>
      <For each={props.poll.choices}>
        {(c) => (
          <Bar
            label={c.title}
            detail={`${share(c.votes, total())}%`}
            pct={share(c.votes, total())}
          />
        )}
      </For>
      <div class="sm-actions">
        <button
          type="button"
          class="btn btn--small"
          disabled={pollPending()}
          onClick={() => void endPoll(props.poll.id, false)}
        >
          End poll
        </button>
      </div>
      <Show when={pollError()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {formatChannelError(e())}
          </div>
        )}
      </Show>
    </div>
  );
};

const PredictionCard: Component<{ prediction: Prediction; now: number }> = (
  props,
) => {
  const [picking, setPicking] = createSignal(false);
  const refund = createConfirmTap();
  const total = () =>
    props.prediction.outcomes.reduce((n, o) => n + o.channel_points, 0);
  const open = () => props.prediction.status === "active";
  const left = () => {
    const at = props.prediction.locks_at;
    return open() && at !== null && at > props.now ? at - props.now : null;
  };

  return (
    <div class="sm-running">
      <div class="sm-running__head">
        <span class="sm-running__kind">
          {open() ? "Prediction open" : "Prediction locked"}
        </span>
        <span class="sm-hint">
          <Show when={left()}>{(l) => `${formatClock(l())} to lock, `}</Show>
          {formatViewers(total())} points
        </span>
      </div>
      <span class="sm-running__title">{props.prediction.title}</span>
      <For each={props.prediction.outcomes}>
        {(o) => (
          <Bar
            label={o.title}
            detail={`${formatViewers(o.users)} in, ${share(o.channel_points, total())}%`}
            pct={share(o.channel_points, total())}
            tone={o.color}
          />
        )}
      </For>
      <Show
        when={picking()}
        fallback={
          <div class="sm-actions">
            <Show when={open()}>
              <button
                type="button"
                class="btn btn--small"
                disabled={predictionPending()}
                onClick={() => void lockPrediction(props.prediction.id)}
              >
                Lock now
              </button>
            </Show>
            <button
              type="button"
              class="btn btn--small btn--primary"
              disabled={predictionPending()}
              onClick={() => setPicking(true)}
            >
              Pick the winner
            </button>
            <button
              type="button"
              class="btn btn--small btn--danger"
              classList={{ "btn--armed": refund.armed() }}
              disabled={predictionPending()}
              onClick={() => {
                if (refund.tap()) void cancelPrediction(props.prediction.id);
              }}
            >
              {refund.armed()
                ? "Tap again to refund everyone"
                : "Cancel and refund"}
            </button>
          </div>
        }
      >
        <div class="sm-actions" role="group" aria-label="Which outcome won?">
          <For each={props.prediction.outcomes}>
            {(o) => (
              <button
                type="button"
                class="btn btn--small btn--primary"
                disabled={predictionPending()}
                onClick={() => {
                  setPicking(false);
                  void resolvePrediction(props.prediction.id, o.id);
                }}
              >
                {o.title} won
              </button>
            )}
          </For>
          <button
            type="button"
            class="btn btn--small"
            onClick={() => setPicking(false)}
          >
            Back
          </button>
        </div>
      </Show>
      <Show when={predictionError()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {formatChannelError(e())}
          </div>
        )}
      </Show>
    </div>
  );
};

const RunningNow: Component<{ now: number }> = (props) => {
  const poll = () => {
    const p = currentPoll();
    return p?.status === "active" ? p : null;
  };
  const prediction = () => {
    const p = currentPrediction();
    return p?.status === "active" || p?.status === "locked" ? p : null;
  };
  return (
    <>
      <Show when={poll()}>
        {(p) => <PollCard poll={p()} now={props.now} />}
      </Show>
      <Show when={prediction()}>
        {(p) => <PredictionCard prediction={p()} now={props.now} />}
      </Show>
    </>
  );
};

export default RunningNow;
