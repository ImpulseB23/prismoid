import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardUser } from "../components/UserCard";

const calls: string[] = [];
let subage: Promise<unknown> = Promise.resolve({});

vi.mock("./twitchChannel", () => ({
  getSubAge: (user: string, channel: string) => {
    calls.push(`sub ${user} ${channel}`);
    return subage;
  },
  getFollowerCount: async (id: string) => {
    calls.push(`followers ${id}`);
    return 3;
  },
  getFollowSince: async (channel: string, user: string) => {
    calls.push(`follow ${channel} ${user}`);
    return null;
  },
}));
vi.mock("../stores/userInfoStore", () => ({
  loadUserInfo: async () => {},
  userInfo: (id: string) => (id === "c1" ? { login: "streamer" } : undefined),
}));
const auth = { userId: "me" };
vi.mock("../stores/authStore", () => ({
  FOLLOWERS_SCOPE: "moderator:read:followers",
  currentUserId: () => auth.userId,
  missingScopes: () => [],
}));
vi.mock("../stores/roleStore", () => ({ canModerateIn: () => false }));

const { followLookup, preloadCardFacts } = await import("./cardFacts");

const user = (id: string): CardUser => ({
  channel_id: "c1",
  platform_user_id: id,
  username: "viewer",
  display_name: "Viewer",
  color: null,
  badges: [],
});

afterEach(() => {
  calls.length = 0;
  subage = Promise.resolve({});
  vi.useRealTimers();
});

describe("followLookup", () => {
  it("asks only where Twitch answers", () => {
    expect(followLookup(user("me"))).toEqual(["c1", "me"]);
    expect(followLookup(user("u1"))).toBe(false);
  });
});

describe("preloadCardFacts", () => {
  it("fetches the sub, followers and follow before settling", async () => {
    await preloadCardFacts(user("me"));
    expect(calls).toEqual([
      "sub viewer streamer",
      "followers me",
      "follow c1 me",
    ]);
  });

  it("gives up waiting on a slow lookup", async () => {
    vi.useFakeTimers();
    subage = new Promise(() => {});
    const done = vi.fn();
    void preloadCardFacts(user("u1"), 100).then(done);
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });
});
