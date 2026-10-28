import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Poll, Prediction } from "../../lib/streamManager";

const [poll, setPoll] = createSignal<Poll | null>(null);
const [prediction, setPrediction] = createSignal<Prediction | null>(null);
const [pollErr, setPollErr] = createSignal<unknown>(null);
const [predictionErr, setPredictionErr] = createSignal<unknown>(null);
const store = {
  endPoll: vi.fn<(id: string, archive: boolean) => Promise<boolean>>(
    async () => true,
  ),
  lockPrediction: vi.fn<(id: string) => Promise<boolean>>(async () => true),
  resolvePrediction: vi.fn<(id: string, o: string) => Promise<boolean>>(
    async () => true,
  ),
  cancelPrediction: vi.fn<(id: string) => Promise<boolean>>(async () => true),
};
vi.mock("../../stores/streamManagerStore", () => ({
  currentPoll: () => poll(),
  currentPrediction: () => prediction(),
  pollPending: () => false,
  pollError: () => pollErr(),
  predictionPending: () => false,
  predictionError: () => predictionErr(),
  endPoll: (id: string, archive: boolean) => store.endPoll(id, archive),
  lockPrediction: (id: string) => store.lockPrediction(id),
  resolvePrediction: (id: string, o: string) => store.resolvePrediction(id, o),
  cancelPrediction: (id: string) => store.cancelPrediction(id),
}));

const { default: RunningNow } = await import("./RunningNow");

const NOW = 1_000_000;

const runningPoll: Poll = {
  id: "p1",
  channel_id: "7",
  title: "Who do we play next?",
  choices: [
    { id: "a", title: "Jinx", votes: 46, channel_points_votes: 0 },
    { id: "b", title: "Ahri", votes: 31, channel_points_votes: 0 },
    { id: "c", title: "Kai'Sa", votes: 23, channel_points_votes: 0 },
  ],
  channel_points_voting_enabled: false,
  channel_points_per_vote: 0,
  status: "active",
  started_at: NOW - 60_000,
  ends_at: NOW + 72_000,
  ended_at: null,
};

const openPrediction: Prediction = {
  id: "r1",
  channel_id: "7",
  title: "Do we win?",
  outcomes: [
    { id: "y", title: "Yes", color: "blue", users: 40, channel_points: 9000 },
    { id: "n", title: "No", color: "pink", users: 12, channel_points: 3400 },
  ],
  status: "active",
  winning_outcome_id: null,
  started_at: NOW - 10_000,
  locks_at: NOW + 50_000,
  locked_at: null,
  ended_at: null,
};

describe("RunningNow", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setPoll(null);
    setPrediction(null);
    setPollErr(null);
    setPredictionErr(null);
  });

  it("shows nothing while nothing runs", () => {
    setPoll({ ...runningPoll, status: "completed" });
    const { container } = render(() => <RunningNow now={NOW} />);
    expect(container.textContent).toBe("");
  });

  it("shows a running poll with its bars and ends it", () => {
    setPoll(runningPoll);
    render(() => <RunningNow now={NOW} />);
    expect(screen.getByText("Poll running")).toBeTruthy();
    expect(screen.getByText("1:12 left, 100 votes")).toBeTruthy();
    const bar = screen.getByRole("meter", { name: "Jinx" });
    expect(bar.getAttribute("aria-valuenow")).toBe("46");
    expect(bar.querySelector("i")!.style.width).toBe("46%");
    fireEvent.click(screen.getByRole("button", { name: "End poll" }));
    expect(store.endPoll).toHaveBeenCalledWith("p1", false);
    setPollErr({ kind: "http", message: "" });
    expect(screen.getByRole("alert").textContent).toContain("Could not reach");
  });

  it("locks, resolves and refunds a prediction", () => {
    setPrediction(openPrediction);
    render(() => <RunningNow now={NOW} />);
    expect(screen.getByText("Prediction open")).toBeTruthy();
    expect(screen.getByText("0:50 to lock, 12K points")).toBeTruthy();
    expect(screen.getByText("40 in, 73%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
    expect(store.lockPrediction).toHaveBeenCalledWith("r1");

    setPrediction({ ...openPrediction, status: "locked", locks_at: null });
    expect(screen.getByText("Prediction locked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock now" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pick the winner" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick the winner" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes won" }));
    expect(store.resolvePrediction).toHaveBeenCalledWith("r1", "y");

    const refund = screen.getByRole("button", { name: "Cancel and refund" });
    fireEvent.click(refund);
    expect(store.cancelPrediction).not.toHaveBeenCalled();
    expect(refund.textContent).toBe("Tap again to refund everyone");
    fireEvent.click(refund);
    expect(store.cancelPrediction).toHaveBeenCalledWith("r1");

    setPredictionErr({ kind: "helix", status: 403, message: "" });
    expect(screen.getByRole("alert").textContent).toContain("cannot do that");
  });
});
