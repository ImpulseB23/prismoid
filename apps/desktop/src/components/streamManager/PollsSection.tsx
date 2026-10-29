// Polls and predictions: start either one, follow the one running now, and
// see how the recent ones ended.

import { Component, For, Match, Switch, createSignal } from "solid-js";
import type { Poll, Prediction } from "../../lib/streamManager";
import { formatViewers } from "../../lib/streamInfo";
import { streamLog, type LogEntry } from "../../stores/streamLogStore";
import { PollForm, PredictionForm } from "./PollForms";
import RunningNow from "./RunningNow";

type Ended = Extract<LogEntry, { kind: "poll" | "prediction" }>;

export function pollResult(poll: Poll): string {
  if (poll.status !== "completed" && poll.status !== "terminated")
    return "Removed";
  const total = poll.choices.reduce((n, c) => n + c.votes, 0);
  if (total === 0) return "No votes";
  const top = Math.max(...poll.choices.map((c) => c.votes));
  const winners = poll.choices.filter((c) => c.votes === top);
  const pct = Math.round((top / total) * 100);
  return winners.length > 1
    ? `Tied at ${pct}%`
    : `${winners[0].title} won, ${pct}%`;
}

export function predictionResult(prediction: Prediction): string {
  const winner = prediction.outcomes.find(
    (o) => o.id === prediction.winning_outcome_id,
  );
  if (prediction.status !== "resolved" || !winner)
    return "Canceled, points refunded";
  const pot = prediction.outcomes.reduce((n, o) => n + o.channel_points, 0);
  return `${winner.title} won, ${formatViewers(pot)} points paid out`;
}

const PollsSection: Component<{ now: number }> = (props) => {
  const [mode, setMode] = createSignal<"poll" | "prediction">("poll");
  const recent = () =>
    streamLog()
      .filter((e): e is Ended => e.kind === "poll" || e.kind === "prediction")
      .reverse();

  return (
    <div class="sm-cols">
      <section class="sm-col sm-col--main" aria-labelledby="sm-start-title">
        <h2 id="sm-start-title" class="sm-heading">
          Start a {mode()}
        </h2>
        <div class="sm-seg" role="radiogroup" aria-label="What to start">
          <For each={["poll", "prediction"] as const}>
            {(m) => (
              <label
                class="sm-seg__option"
                classList={{ "sm-seg__option--on": mode() === m }}
              >
                <input
                  type="radio"
                  class="sm-sr"
                  name="sm-start"
                  checked={mode() === m}
                  onChange={() => setMode(m)}
                />
                {m === "poll" ? "Poll" : "Prediction"}
              </label>
            )}
          </For>
        </div>
        <Switch>
          <Match when={mode() === "poll"}>
            <PollForm />
          </Match>
          <Match when={mode() === "prediction"}>
            <PredictionForm />
          </Match>
        </Switch>
      </section>
      <section class="sm-col" aria-labelledby="sm-recent-title">
        <RunningNow now={props.now} />
        <div class="sm-list">
          <h2 id="sm-recent-title" class="sm-heading">
            Recent
          </h2>
          <For
            each={recent()}
            fallback={
              <div class="sm-hint">
                Polls and predictions show here once they end.
              </div>
            }
          >
            {(e) => (
              <div class="sm-list__row">
                <span class="sm-list__main">
                  {e.kind === "poll" ? e.poll.title : e.prediction.title}
                </span>
                <span class="sm-list__meta">
                  {e.kind === "poll"
                    ? pollResult(e.poll)
                    : predictionResult(e.prediction)}
                </span>
              </div>
            )}
          </For>
        </div>
      </section>
    </div>
  );
};

export default PollsSection;
