import { describe, expect, it, vi } from "vitest";
import type {
  Category,
  ChannelInfo,
  Poll,
  Prediction,
} from "../lib/streamManager";
import {
  createStreamManagerStore,
  type StreamManagerApi,
} from "./streamManagerStore";

const info: ChannelInfo = {
  broadcaster_id: "7",
  title: "hello",
  game_id: "509658",
  game_name: "Just Chatting",
};

const poll = (over: Partial<Poll> = {}): Poll => ({
  id: "p1",
  channel_id: "7",
  title: "Heads or Tails?",
  choices: [
    { id: "c1", title: "Heads", votes: 0, channel_points_votes: 0 },
    { id: "c2", title: "Tails", votes: 0, channel_points_votes: 0 },
  ],
  channel_points_voting_enabled: false,
  channel_points_per_vote: 0,
  status: "active",
  started_at: 1000,
  ends_at: 61_000,
  ended_at: null,
  ...over,
});

const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  id: "d1",
  channel_id: "7",
  title: "Win?",
  outcomes: [
    { id: "o1", title: "Yes", color: "blue", users: 0, channel_points: 0 },
    { id: "o2", title: "No", color: "pink", users: 0, channel_points: 0 },
  ],
  status: "active",
  winning_outcome_id: null,
  started_at: 1000,
  locks_at: 121_000,
  locked_at: null,
  ended_at: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi(over: Partial<StreamManagerApi> = {}): StreamManagerApi {
  return {
    getChannelInfo: vi.fn(async () => info),
    updateChannelInfo: vi.fn(async (u) => ({ ...info, ...u })),
    searchCategories: vi.fn(async () => []),
    getPoll: vi.fn(async () => null),
    createPoll: vi.fn(async () => poll()),
    endPoll: vi.fn(async () => poll({ status: "terminated", ended_at: 5000 })),
    getPrediction: vi.fn(async () => null),
    createPrediction: vi.fn(async () => prediction()),
    lockPrediction: vi.fn(async () =>
      prediction({ status: "locked", locked_at: 3000 }),
    ),
    resolvePrediction: vi.fn(async (_id, outcome) =>
      prediction({ status: "resolved", winning_outcome_id: outcome }),
    ),
    cancelPrediction: vi.fn(async () => prediction({ status: "canceled" })),
    ...over,
  };
}

describe("streamManagerStore", () => {
  it("loads all three areas for the signed-in user", async () => {
    const api = fakeApi({
      getPoll: async () => poll({ status: "completed" }),
      getPrediction: async () => prediction(),
    });
    const s = createStreamManagerStore(api, () => "7");
    await s.load();
    expect(s.channelInfo()).toEqual(info);
    expect(s.poll()?.status).toBe("completed");
    expect(s.prediction()?.id).toBe("d1");
    expect(s.loading()).toBe(false);
  });

  it("does nothing while signed out", async () => {
    const api = fakeApi();
    const s = createStreamManagerStore(api, () => null);
    await s.load();
    expect(api.getChannelInfo).not.toHaveBeenCalled();
  });

  it("keeps each area's load error to itself", async () => {
    const denied = { kind: "helix", status: 401, message: "missing scope" };
    const s = createStreamManagerStore(
      fakeApi({
        getPoll: async () => {
          throw denied;
        },
      }),
      () => "7",
    );
    await s.load();
    expect(s.channelInfo()).toEqual(info);
    expect(s.pollError()).toEqual(denied);
    expect(s.infoError()).toBeNull();
    expect(s.predictionError()).toBeNull();
  });

  it("updates info with pending and error state", async () => {
    const gate = deferred<ChannelInfo>();
    const api = fakeApi({ updateChannelInfo: () => gate.promise });
    const s = createStreamManagerStore(api, () => "7");
    const done = s.updateInfo({ title: "new" });
    expect(s.infoPending()).toBe(true);
    gate.resolve({ ...info, title: "new" });
    expect(await done).toBe(true);
    expect(s.infoPending()).toBe(false);
    expect(s.channelInfo()?.title).toBe("new");

    const bad = { kind: "invalid_setting", message: "title cannot be empty" };
    const failing = createStreamManagerStore(
      fakeApi({
        updateChannelInfo: async () => {
          throw bad;
        },
      }),
      () => "7",
    );
    expect(await failing.updateInfo({ title: " " })).toBe(false);
    expect(failing.infoError()).toEqual(bad);
    expect(failing.infoPending()).toBe(false);
  });

  it("keeps only the latest category search", async () => {
    const slow = deferred<Category[]>();
    const fast = deferred<Category[]>();
    const api = fakeApi({
      searchCategories: vi
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockReturnValueOnce(fast.promise),
    });
    const s = createStreamManagerStore(api, () => "7");
    const first = s.searchCategories("for");
    const second = s.searchCategories(" fort ");
    expect(api.searchCategories).toHaveBeenLastCalledWith("fort");
    fast.resolve([{ id: "33214", name: "Fortnite", box_art_url: "" }]);
    await second;
    slow.resolve([{ id: "1", name: "Forza", box_art_url: "" }]);
    await first;
    expect(s.categories().map((c) => c.name)).toEqual(["Fortnite"]);
    expect(s.searching()).toBe(false);

    await s.searchCategories("  ");
    expect(s.categories()).toEqual([]);
    expect(api.searchCategories).toHaveBeenCalledTimes(2);
  });

  it("runs a poll from create to end", async () => {
    const api = fakeApi();
    const s = createStreamManagerStore(api, () => "7");
    expect(
      await s.createPoll({
        title: "Heads or Tails?",
        choices: ["Heads", "Tails"],
        duration: 60,
        channel_points_per_vote: null,
      }),
    ).toBe(true);
    expect(s.poll()?.status).toBe("active");

    s.applyPoll(
      poll({
        choices: [
          { id: "c1", title: "Heads", votes: 4, channel_points_votes: 1 },
          { id: "c2", title: "Tails", votes: 2, channel_points_votes: 0 },
        ],
      }),
    );
    expect(s.poll()?.choices[0].votes).toBe(4);

    expect(await s.endPoll("p1", false)).toBe(true);
    expect(api.endPoll).toHaveBeenCalledWith("p1", false);
    expect(s.poll()?.status).toBe("terminated");
  });

  it("never lets a late update undo a finished poll or an older one win", () => {
    const s = createStreamManagerStore(fakeApi(), () => "7");
    s.applyPoll(poll({ status: "completed", ended_at: 61_000 }));
    s.applyPoll(poll());
    expect(s.poll()?.status).toBe("completed");

    s.applyPoll(poll({ id: "p2", started_at: 90_000 }));
    expect(s.poll()?.id).toBe("p2");
    s.applyPoll(poll({ id: "p1", status: "archived" }));
    expect(s.poll()?.id).toBe("p2");
  });

  it("ignores updates from other channels", () => {
    const s = createStreamManagerStore(fakeApi(), () => "7");
    s.applyPoll(poll({ channel_id: "8" }));
    s.applyPrediction(prediction({ channel_id: "8" }));
    expect(s.poll()).toBeNull();
    expect(s.prediction()).toBeNull();
  });

  it("does not let a slow initial load overwrite a live update", async () => {
    const gate = deferred<Poll | null>();
    const s = createStreamManagerStore(
      fakeApi({ getPoll: () => gate.promise }),
      () => "7",
    );
    const loading = s.load();
    s.applyPoll(poll({ status: "completed" }));
    gate.resolve(poll());
    await loading;
    expect(s.poll()?.status).toBe("completed");
  });

  it("walks a prediction through lock and resolve", async () => {
    const api = fakeApi();
    const s = createStreamManagerStore(api, () => "7");
    await s.createPrediction({
      title: "Win?",
      outcomes: ["Yes", "No"],
      prediction_window: 120,
    });
    expect(await s.lockPrediction("d1")).toBe(true);
    expect(s.prediction()?.status).toBe("locked");
    // a progress notification sent before the lock arrives after it
    s.applyPrediction(prediction());
    expect(s.prediction()?.status).toBe("locked");
    expect(await s.resolvePrediction("d1", "o2")).toBe(true);
    expect(api.resolvePrediction).toHaveBeenCalledWith("d1", "o2");
    expect(s.prediction()?.winning_outcome_id).toBe("o2");
    s.applyPrediction(prediction({ status: "locked" }));
    expect(s.prediction()?.status).toBe("resolved");
  });

  it("surfaces a failed cancel and keeps the prediction", async () => {
    const err = { kind: "helix", status: 400, message: "already resolved" };
    const s = createStreamManagerStore(
      fakeApi({
        cancelPrediction: async () => {
          throw err;
        },
      }),
      () => "7",
    );
    s.applyPrediction(prediction({ status: "locked" }));
    expect(await s.cancelPrediction("d1")).toBe(false);
    expect(s.predictionError()).toEqual(err);
    expect(s.prediction()?.status).toBe("locked");
    expect(s.predictionPending()).toBe(false);
  });

  it("drops results that land after a clear", async () => {
    const gate = deferred<Poll>();
    const s = createStreamManagerStore(
      fakeApi({ createPoll: () => gate.promise }),
      () => "7",
    );
    const creating = s.createPoll({
      title: "t",
      choices: ["a", "b"],
      duration: 15,
      channel_points_per_vote: null,
    });
    s.clear();
    gate.resolve(poll());
    await creating;
    expect(s.poll()).toBeNull();
    expect(s.pollPending()).toBe(false);
  });
});
