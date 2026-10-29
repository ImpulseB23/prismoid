// Forms to start a poll or a prediction on the user's channel, within the
// limits Twitch enforces. Each clears itself once Twitch has accepted it.

import { Component, For, Index, Show, createSignal } from "solid-js";
import { LIMITS } from "../../lib/streamManager";
import { formatChannelError } from "../../lib/twitchChannel";
import {
  createPoll,
  createPrediction,
  currentPoll,
  currentPrediction,
  pollError,
  pollPending,
  predictionError,
  predictionPending,
} from "../../stores/streamManagerStore";

const POLL_DURATIONS = [60, 120, 180, 300, 600];
const PREDICTION_WINDOWS = [30, 60, 120, 300, 600, 1800];
const DEFAULT_POINTS = 100;

const spell = (secs: number) =>
  secs < 60
    ? `${secs} seconds`
    : secs === 60
      ? "1 minute"
      : `${secs / 60} minutes`;

const Counter: Component<{ for: string; label: string; left: number }> = (
  props,
) => (
  <label class="sm-label" for={props.for}>
    {props.label}
    <span
      class="sm-label__aside"
      classList={{ "sm-label__aside--full": props.left <= 0 }}
    >
      {props.left} left
    </span>
  </label>
);

const ChoiceList: Component<{
  id: string;
  label: string;
  noun: string;
  items: string[];
  range: readonly [number, number];
  maxChars: number;
  onChange: (items: string[]) => void;
}> = (props) => {
  const set = (i: number, v: string) =>
    props.onChange(props.items.map((x, j) => (j === i ? v : x)));
  return (
    <div class="sm-field" role="group" aria-labelledby={props.id}>
      <span class="sm-label" id={props.id}>
        {props.label}, {props.range[0]} to {props.range[1]}
      </span>
      <Index each={props.items}>
        {(item, i) => (
          <div class="sm-inline">
            <input
              type="text"
              class="sm-input"
              aria-label={`${props.noun} ${i + 1}`}
              maxLength={props.maxChars}
              value={item()}
              onInput={(e) => set(i, e.currentTarget.value)}
            />
            <Show when={props.items.length > props.range[0]}>
              <button
                type="button"
                class="btn btn--small"
                aria-label={`Remove ${props.noun.toLowerCase()} ${i + 1}`}
                onClick={() =>
                  props.onChange(props.items.filter((_, j) => j !== i))
                }
              >
                Remove
              </button>
            </Show>
          </div>
        )}
      </Index>
      <Show when={props.items.length < props.range[1]}>
        <button
          type="button"
          class="sm-link sm-link--start"
          onClick={() => props.onChange([...props.items, ""])}
        >
          Add a {props.noun.toLowerCase()}
        </button>
      </Show>
    </div>
  );
};

const filled = (items: string[]) => items.every((x) => x.trim() !== "");
const blank = (n: number) => Array.from({ length: n }, () => "");

export const PollForm: Component = () => {
  const [title, setTitle] = createSignal("");
  const [choices, setChoices] = createSignal(blank(LIMITS.pollChoices[0]));
  const [duration, setDuration] = createSignal(120);
  const [usePoints, setUsePoints] = createSignal(false);
  const [points, setPoints] = createSignal(String(DEFAULT_POINTS));

  const pointsValue = () => {
    const n = Number(points());
    const [min, max] = LIMITS.pollPointsPerVote;
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const running = () => currentPoll()?.status === "active";
  const ready = () =>
    title().trim() !== "" &&
    filled(choices()) &&
    (!usePoints() || pointsValue() !== null);

  const start = async (e: SubmitEvent) => {
    e.preventDefault();
    const ok = await createPoll({
      title: title().trim(),
      choices: choices().map((c) => c.trim()),
      duration: duration(),
      channel_points_per_vote: usePoints() ? pointsValue() : null,
    });
    if (!ok) return;
    setTitle("");
    setChoices(blank(LIMITS.pollChoices[0]));
  };

  return (
    <form class="sm-form" onSubmit={start}>
      <div class="sm-field">
        <Counter
          for="sm-poll-title"
          label="Question"
          left={LIMITS.pollTitleChars - title().length}
        />
        <input
          id="sm-poll-title"
          type="text"
          class="sm-input"
          maxLength={LIMITS.pollTitleChars}
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </div>
      <ChoiceList
        id="sm-poll-choices"
        label="Choices"
        noun="Choice"
        items={choices()}
        range={LIMITS.pollChoices}
        maxChars={LIMITS.pollChoiceChars}
        onChange={setChoices}
      />
      <div class="sm-row">
        <div class="sm-field sm-field--narrow">
          <label class="sm-label" for="sm-poll-duration">
            Runs for
          </label>
          <select
            id="sm-poll-duration"
            class="sm-input"
            onChange={(e) => setDuration(Number(e.currentTarget.value))}
          >
            <For each={POLL_DURATIONS}>
              {(s) => (
                <option value={s} selected={s === duration()}>
                  {spell(s)}
                </option>
              )}
            </For>
          </select>
        </div>
        <div class="sm-field sm-field--wide">
          <label class="sm-toggle sm-toggle--bare">
            <input
              type="checkbox"
              class="switch"
              role="switch"
              checked={usePoints()}
              onChange={(e) => setUsePoints(e.currentTarget.checked)}
            />
            Extra votes with Channel Points
          </label>
          <Show when={usePoints()}>
            <div class="sm-inline sm-inline--center">
              <input
                type="text"
                inputMode="numeric"
                class="sm-input sm-input--short"
                aria-label="Points a vote"
                value={points()}
                onInput={(e) => setPoints(e.currentTarget.value)}
              />
              <span class="sm-hint">points a vote</span>
            </div>
          </Show>
        </div>
      </div>
      <div class="sm-actions">
        <button
          type="submit"
          class="btn btn--small btn--primary"
          disabled={!ready() || pollPending() || running()}
        >
          Start poll
        </button>
        <Show when={running()}>
          <span class="sm-hint">One poll runs at a time. End it first.</span>
        </Show>
      </div>
      {/* While one runs, its card shows the errors. */}
      <Show when={!running() && pollError()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {formatChannelError(e())}
          </div>
        )}
      </Show>
    </form>
  );
};

export const PredictionForm: Component = () => {
  const [title, setTitle] = createSignal("");
  const [outcomes, setOutcomes] = createSignal(
    blank(LIMITS.predictionOutcomes[0]),
  );
  const [openFor, setOpenFor] = createSignal(120);

  const running = () => {
    const s = currentPrediction()?.status;
    return s === "active" || s === "locked";
  };
  const ready = () => title().trim() !== "" && filled(outcomes());

  const start = async (e: SubmitEvent) => {
    e.preventDefault();
    const ok = await createPrediction({
      title: title().trim(),
      outcomes: outcomes().map((o) => o.trim()),
      prediction_window: openFor(),
    });
    if (!ok) return;
    setTitle("");
    setOutcomes(blank(LIMITS.predictionOutcomes[0]));
  };

  return (
    <form class="sm-form" onSubmit={start}>
      <div class="sm-field">
        <Counter
          for="sm-prediction-title"
          label="What are viewers predicting?"
          left={LIMITS.predictionTitleChars - title().length}
        />
        <input
          id="sm-prediction-title"
          type="text"
          class="sm-input"
          maxLength={LIMITS.predictionTitleChars}
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </div>
      <ChoiceList
        id="sm-prediction-outcomes"
        label="Outcomes"
        noun="Outcome"
        items={outcomes()}
        range={LIMITS.predictionOutcomes}
        maxChars={LIMITS.predictionOutcomeChars}
        onChange={setOutcomes}
      />
      <div class="sm-field sm-field--narrow">
        <label class="sm-label" for="sm-prediction-window">
          Open for
        </label>
        <select
          id="sm-prediction-window"
          class="sm-input"
          onChange={(e) => setOpenFor(Number(e.currentTarget.value))}
        >
          <For each={PREDICTION_WINDOWS}>
            {(s) => (
              <option value={s} selected={s === openFor()}>
                {spell(s)}
              </option>
            )}
          </For>
        </select>
      </div>
      <div class="sm-actions">
        <button
          type="submit"
          class="btn btn--small btn--primary"
          disabled={!ready() || predictionPending() || running()}
        >
          Start prediction
        </button>
        <Show when={running()}>
          <span class="sm-hint">
            One prediction runs at a time. Pick the winner or cancel it first.
          </span>
        </Show>
      </div>
      <Show when={!running() && predictionError()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {formatChannelError(e())}
          </div>
        )}
      </Show>
    </form>
  );
};
