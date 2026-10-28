// What happened on the user's stream while the stream manager was open: ad
// breaks, markers, and polls and predictions once they end. Twitch keeps no
// history the app can read for most of these, so the timeline and the
// recent lists show only what this window saw or loaded itself.

import { createEffect, createSignal } from "solid-js";
import type { AdBreak } from "../lib/ads";
import type { Marker } from "../lib/quickActions";
import type { Poll, Prediction } from "../lib/streamManager";

export type LogEntry =
  | { kind: "ad"; id: string; at: number; ad: AdBreak }
  | { kind: "marker"; id: string; at: number; marker: Marker }
  | { kind: "poll"; id: string; at: number; poll: Poll }
  | { kind: "prediction"; id: string; at: number; prediction: Prediction };

export interface StreamLogSources {
  adBreak: () => AdBreak | null;
  poll: () => Poll | null;
  prediction: () => Prediction | null;
}

export interface StreamLog {
  /** Oldest first. */
  entries: () => LogEntry[];
  /** Adds an entry, replacing an earlier one of the same kind and id. */
  record: (entry: LogEntry) => void;
  /**
   * Records ad breaks as they start and polls and predictions once they
   * end. Call from a component so the effects have an owner.
   */
  follow: (sources: StreamLogSources) => void;
  clear: () => void;
}

export function createStreamLog(): StreamLog {
  const [entries, setEntries] = createSignal<LogEntry[]>([]);

  const record = (entry: LogEntry) =>
    setEntries((list) =>
      [
        ...list.filter((e) => e.kind !== entry.kind || e.id !== entry.id),
        entry,
      ].sort((a, b) => a.at - b.at),
    );

  function follow(sources: StreamLogSources): void {
    createEffect(() => {
      const ad = sources.adBreak();
      if (ad)
        record({
          kind: "ad",
          id: String(ad.started_at),
          at: ad.started_at,
          ad,
        });
    });
    createEffect(() => {
      const poll = sources.poll();
      if (poll && poll.status !== "active" && poll.ended_at !== null) {
        record({ kind: "poll", id: poll.id, at: poll.ended_at, poll });
      }
    });
    createEffect(() => {
      const prediction = sources.prediction();
      if (
        prediction &&
        (prediction.status === "resolved" ||
          prediction.status === "canceled") &&
        prediction.ended_at !== null
      ) {
        record({
          kind: "prediction",
          id: prediction.id,
          at: prediction.ended_at,
          prediction,
        });
      }
    });
  }

  return { entries, record, follow, clear: () => setEntries([]) };
}

const defaultLog = createStreamLog();
export const streamLog = defaultLog.entries;
export const recordStreamEvent = defaultLog.record;
export const followStreamLog = defaultLog.follow;
export const clearStreamLog = defaultLog.clear;
