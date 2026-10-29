import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type {
  NewPoll,
  NewPrediction,
  Poll,
  Prediction,
} from "../../lib/streamManager";

const [poll, setPoll] = createSignal<Poll | null>(null);
const [prediction, setPrediction] = createSignal<Prediction | null>(null);
const [pollErr, setPollErr] = createSignal<unknown>(null);
const createPoll = vi.fn<(p: NewPoll) => Promise<boolean>>(async () => true);
const createPrediction = vi.fn<(p: NewPrediction) => Promise<boolean>>(
  async () => true,
);
vi.mock("../../stores/streamManagerStore", () => ({
  currentPoll: () => poll(),
  currentPrediction: () => prediction(),
  pollPending: () => false,
  pollError: () => pollErr(),
  predictionPending: () => false,
  predictionError: () => null,
  createPoll: (p: NewPoll) => createPoll(p),
  createPrediction: (p: NewPrediction) => createPrediction(p),
  endPoll: vi.fn(),
  lockPrediction: vi.fn(),
  resolvePrediction: vi.fn(),
  cancelPrediction: vi.fn(),
}));

const {
  default: PollsSection,
  pollResult,
  predictionResult,
} = await import("./PollsSection");
const { recordStreamEvent, clearStreamLog } =
  await import("../../stores/streamLogStore");

const basePoll: Poll = {
  id: "p1",
  channel_id: "7",
  title: "Pizza or ramen?",
  choices: [
    { id: "a", title: "Pizza", votes: 29, channel_points_votes: 0 },
    { id: "b", title: "Ramen", votes: 71, channel_points_votes: 0 },
  ],
  channel_points_voting_enabled: false,
  channel_points_per_vote: 0,
  status: "completed",
  started_at: 1,
  ends_at: null,
  ended_at: 2,
};

const basePrediction: Prediction = {
  id: "r1",
  channel_id: "7",
  title: "Do we win?",
  outcomes: [
    { id: "y", title: "Yes", color: "blue", users: 4, channel_points: 9000 },
    { id: "n", title: "No", color: "pink", users: 2, channel_points: 3400 },
  ],
  status: "resolved",
  winning_outcome_id: "y",
  started_at: 1,
  locks_at: null,
  locked_at: 2,
  ended_at: 3,
};

const type = (label: string | RegExp, value: string) =>
  fireEvent.input(screen.getByLabelText(label), { target: { value } });

describe("PollsSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setPoll(null);
    setPrediction(null);
    setPollErr(null);
    clearStreamLog();
  });

  it("starts a poll with Channel Points votes", async () => {
    render(() => <PollsSection now={0} />);
    const start = screen.getByRole<HTMLButtonElement>("button", {
      name: "Start poll",
    });
    expect(start.disabled).toBe(true);
    type(/^Question/, "Which skin?");
    type("Choice 1", "Star Guardian");
    type("Choice 2", "Arcane");
    fireEvent.click(screen.getByRole("button", { name: "Add a choice" }));
    type("Choice 3", "Prestige");
    fireEvent.click(screen.getByRole("button", { name: "Remove choice 3" }));
    fireEvent.change(screen.getByLabelText("Runs for"), {
      target: { value: "300" },
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Extra votes with Channel Points" }),
    );
    type("Points a vote", "abc");
    expect(start.disabled).toBe(true);
    type("Points a vote", "250");
    fireEvent.click(start);
    expect(createPoll).toHaveBeenCalledWith({
      title: "Which skin?",
      choices: ["Star Guardian", "Arcane"],
      duration: 300,
      channel_points_per_vote: 250,
    });
    await vi.waitFor(() =>
      expect(
        (screen.getByLabelText(/^Question/) as HTMLInputElement).value,
      ).toBe(""),
    );

    setPoll({ ...basePoll, status: "active", ended_at: null });
    expect(
      screen.getByText("One poll runs at a time. End it first."),
    ).toBeTruthy();
    setPollErr({ kind: "invalid_setting", message: "Too long" });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    setPoll(null);
    expect(screen.getByRole("alert").textContent).toBe("Too long");
  });

  it("starts a prediction and keeps a failed one filled in", async () => {
    render(() => <PollsSection now={0} />);
    fireEvent.click(screen.getByLabelText("Prediction"));
    type(/^What are viewers predicting/, "Do we win?");
    type("Outcome 1", "Yes");
    type("Outcome 2", "No");
    fireEvent.change(screen.getByLabelText("Open for"), {
      target: { value: "30" },
    });
    createPrediction.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Start prediction" }));
    expect(createPrediction).toHaveBeenCalledWith({
      title: "Do we win?",
      outcomes: ["Yes", "No"],
      prediction_window: 30,
    });
    await Promise.resolve();
    expect(
      (screen.getByLabelText(/^What are viewers/) as HTMLInputElement).value,
    ).toBe("Do we win?");

    setPrediction({ ...basePrediction, status: "locked" });
    expect(screen.getByText(/One prediction runs at a time/)).toBeTruthy();
  });

  it("lists how recent ones ended, newest first", () => {
    render(() => <PollsSection now={0} />);
    expect(screen.getByText(/show here once they end/)).toBeTruthy();
    recordStreamEvent({ kind: "poll", id: "p1", at: 2, poll: basePoll });
    recordStreamEvent({
      kind: "prediction",
      id: "r1",
      at: 3,
      prediction: basePrediction,
    });
    const rows = [...document.querySelectorAll(".sm-list__row")].map(
      (r) => r.textContent,
    );
    expect(rows).toEqual([
      "Do we win?Yes won, 12K points paid out",
      "Pizza or ramen?Ramen won, 71%",
    ]);
  });
});

describe("results", () => {
  it("says how a poll ended", () => {
    expect(pollResult({ ...basePoll, status: "archived" })).toBe("Removed");
    expect(
      pollResult({
        ...basePoll,
        choices: basePoll.choices.map((c) => ({ ...c, votes: 0 })),
      }),
    ).toBe("No votes");
    expect(
      pollResult({
        ...basePoll,
        choices: basePoll.choices.map((c) => ({ ...c, votes: 5 })),
      }),
    ).toBe("Tied at 50%");
  });

  it("says how a prediction ended", () => {
    expect(
      predictionResult({
        ...basePrediction,
        status: "canceled",
        winning_outcome_id: null,
      }),
    ).toBe("Canceled, points refunded");
  });
});
