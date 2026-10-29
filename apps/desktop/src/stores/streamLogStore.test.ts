import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { AdBreak } from "../lib/ads";
import type { Poll, Prediction } from "../lib/streamManager";
import { createStreamLog } from "./streamLogStore";

const ad: AdBreak = {
  channel_id: "7",
  duration_seconds: 90,
  started_at: 5_000,
  is_automatic: true,
  requester_id: "7",
  requester_login: "me",
  requester_name: "Me",
};

const poll = (over: Partial<Poll> = {}): Poll => ({
  id: "p1",
  channel_id: "7",
  title: "Pizza or ramen?",
  choices: [],
  channel_points_voting_enabled: false,
  channel_points_per_vote: 0,
  status: "active",
  started_at: 1_000,
  ends_at: 61_000,
  ended_at: null,
  ...over,
});

const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  id: "r1",
  channel_id: "7",
  title: "Do we win?",
  outcomes: [],
  status: "active",
  winning_outcome_id: null,
  started_at: 2_000,
  locks_at: 32_000,
  locked_at: null,
  ended_at: null,
  ...over,
});

describe("createStreamLog", () => {
  it("keeps entries oldest first and replaces by kind and id", () => {
    const log = createStreamLog();
    log.record({ kind: "ad", id: "9", at: 9, ad });
    log.record({ kind: "ad", id: "3", at: 3, ad });
    log.record({
      kind: "ad",
      id: "9",
      at: 9,
      ad: { ...ad, is_automatic: false },
    });
    expect(log.entries().map((e) => e.id)).toEqual(["3", "9"]);
    const last = log.entries()[1];
    expect(last.kind === "ad" && last.ad.is_automatic).toBe(false);
    log.clear();
    expect(log.entries()).toEqual([]);
  });

  it("follows ad breaks and finished polls and predictions", () => {
    const log = createStreamLog();
    const [adBreak, setAdBreak] = createSignal<AdBreak | null>(null);
    const [current, setPoll] = createSignal<Poll | null>(poll());
    const [pred, setPrediction] = createSignal<Prediction | null>(prediction());
    const dispose = createRoot((dispose) => {
      log.follow({ adBreak, poll: current, prediction: pred });
      return dispose;
    });
    expect(log.entries()).toEqual([]);

    setAdBreak(ad);
    setAdBreak(null);
    setPoll(poll({ status: "completed", ended_at: 61_000 }));
    setPrediction(prediction({ status: "locked", locked_at: 32_000 }));
    expect(log.entries().map((e) => e.kind)).toEqual(["ad", "poll"]);

    setPrediction(prediction({ status: "resolved", ended_at: 90_000 }));
    expect(log.entries().map((e) => e.kind)).toEqual([
      "ad",
      "poll",
      "prediction",
    ]);
    dispose();
  });
});
