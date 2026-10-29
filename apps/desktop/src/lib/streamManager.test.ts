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
  getContentLabels,
  getPoll,
  getPrediction,
  labelChanges,
  labelLocale,
  lockPrediction,
  resolvePrediction,
  STREAM_LANGUAGES,
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
    await getContentLabels("de-DE");
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
      ["twitch_get_content_labels", { locale: "de-DE" }],
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

describe("labelLocale", () => {
  it("prefers an exact match, then the same language", () => {
    expect(labelLocale(["de-DE"])).toBe("de-DE");
    expect(labelLocale(["en-gb"])).toBe("en-GB");
    expect(labelLocale(["de-AT", "en-US"])).toBe("de-DE");
    expect(labelLocale(["pt-BR"])).toBe("pt-PT");
    expect(labelLocale(["ja"])).toBe("ja-JP");
  });

  it("falls back to en-US", () => {
    expect(labelLocale(["ar-EG"])).toBe("en-US");
    expect(labelLocale([])).toBe("en-US");
  });
});

describe("labelChanges", () => {
  it("enables new labels and disables dropped ones", () => {
    expect(
      labelChanges(["Gambling", "MatureGame"], ["MatureGame", "SexualThemes"]),
    ).toEqual([
      { id: "SexualThemes", is_enabled: true },
      { id: "Gambling", is_enabled: false },
    ]);
  });

  it("is null when nothing changes", () => {
    expect(labelChanges(["Gambling"], ["Gambling"])).toBeNull();
    expect(labelChanges([], [])).toBeNull();
  });
});

describe("STREAM_LANGUAGES", () => {
  it("is every ISO 639-1 code plus other", () => {
    expect(STREAM_LANGUAGES).toHaveLength(184);
    expect(new Set(STREAM_LANGUAGES).size).toBe(184);
    expect(STREAM_LANGUAGES.at(-1)).toBe("other");
    expect(
      STREAM_LANGUAGES.slice(0, -1).every((c) => /^[a-z]{2}$/.test(c)),
    ).toBe(true);
  });
});
