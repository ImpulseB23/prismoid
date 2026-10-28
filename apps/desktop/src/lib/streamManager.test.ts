import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  cancelPrediction,
  createPoll,
  createPrediction,
  endPoll,
  getChannelInfo,
  getPoll,
  getPrediction,
  lockPrediction,
  resolvePrediction,
  searchCategories,
  updateChannelInfo,
} from "./streamManager";

afterEach(() => {
  invokeMock.mockReset();
});

describe("stream manager commands", () => {
  it("passes arguments the way the host commands name them", async () => {
    invokeMock.mockResolvedValue(null);
    await getChannelInfo();
    await updateChannelInfo({ game_id: "" });
    await searchCategories("fort");
    await getPoll();
    await createPoll({
      title: "Heads or Tails?",
      choices: ["Heads", "Tails"],
      duration: 60,
      channel_points_per_vote: null,
    });
    await endPoll("p1", true);
    await getPrediction();
    await createPrediction({
      title: "Win?",
      outcomes: ["Yes", "No"],
      prediction_window: 120,
    });
    await lockPrediction("d1");
    await resolvePrediction("d1", "o1");
    await cancelPrediction("d1");

    expect(invokeMock.mock.calls).toEqual([
      ["twitch_get_channel_info"],
      ["twitch_update_channel_info", { update: { game_id: "" } }],
      ["twitch_search_categories", { query: "fort" }],
      ["twitch_get_poll"],
      [
        "twitch_create_poll",
        {
          poll: {
            title: "Heads or Tails?",
            choices: ["Heads", "Tails"],
            duration: 60,
            channel_points_per_vote: null,
          },
        },
      ],
      ["twitch_end_poll", { pollId: "p1", archive: true }],
      ["twitch_get_prediction"],
      [
        "twitch_create_prediction",
        {
          prediction: {
            title: "Win?",
            outcomes: ["Yes", "No"],
            prediction_window: 120,
          },
        },
      ],
      ["twitch_lock_prediction", { predictionId: "d1" }],
      [
        "twitch_resolve_prediction",
        { predictionId: "d1", winningOutcomeId: "o1" },
      ],
      ["twitch_cancel_prediction", { predictionId: "d1" }],
    ]);
  });
});
