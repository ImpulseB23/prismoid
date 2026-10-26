import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  USER_INFO_BATCH,
  accountAgeDays,
  createUserInfoStore,
  formatJoined,
  isNewAccount,
} from "./userInfoStore";

const user = (id: string, createdAt = "2020-01-01T00:00:00Z") => ({
  id,
  login: `u${id}`,
  display_name: `U${id}`,
  profile_image_url: "",
  description: "",
  created_at: createdAt,
});

function manualSchedule() {
  const pending: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
    },
    run: () => {
      for (const fn of pending.splice(0)) fn();
    },
  };
}

describe("userInfoStore", () => {
  it("batches queued ids into one request and dedupes repeats", async () => {
    const calls: string[][] = [];
    const sched = manualSchedule();
    const store = createUserInfoStore(async (ids) => {
      calls.push(ids);
      return ids.map((id) => user(id));
    }, sched.schedule);
    store.ensure(["1", "2"]);
    store.ensure(["2", "3", ""]);
    sched.run();
    await store.flush();
    expect(calls).toEqual([["1", "2", "3"]]);
    expect(store.info("3")?.login).toBe("u3");
    store.ensure(["1"]);
    sched.run();
    await store.flush();
    expect(calls).toHaveLength(1);
  });

  it("splits oversize batches at the Helix limit", async () => {
    const calls: string[][] = [];
    const sched = manualSchedule();
    const store = createUserInfoStore(async (ids) => {
      calls.push(ids);
      return ids.map((id) => user(id));
    }, sched.schedule);
    store.ensure(Array.from({ length: USER_INFO_BATCH + 5 }, (_, i) => `${i}`));
    sched.run();
    await store.flush();
    expect(calls.map((c) => c.length)).toEqual([USER_INFO_BATCH, 5]);
  });

  it("lets a failed batch be retried later", async () => {
    let fail = true;
    const sched = manualSchedule();
    const store = createUserInfoStore(async (ids) => {
      if (fail) throw new Error("503");
      return ids.map((id) => user(id));
    }, sched.schedule);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.ensure(["1"]);
    sched.run();
    await store.flush();
    spy.mockRestore();
    expect(store.info("1")).toBeUndefined();
    fail = false;
    store.ensure(["1"]);
    sched.run();
    await store.flush();
    expect(store.info("1")).toBeDefined();
  });
});

describe("account age", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");

  it("counts whole days and flags young accounts", () => {
    expect(accountAgeDays("2026-10-23T18:00:00Z", now)).toBe(1);
    expect(accountAgeDays("garbage", now)).toBeNull();
    expect(isNewAccount(user("1", "2026-10-20T00:00:00Z"), now)).toBe(true);
    expect(isNewAccount(user("1", "2026-10-01T00:00:00Z"), now)).toBe(false);
    expect(isNewAccount(undefined, now)).toBe(false);
  });

  it("formats the joined line by age", () => {
    expect(formatJoined("2026-10-25T01:00:00Z", now)).toBe("Joined today");
    expect(formatJoined("2026-10-24T01:00:00Z", now)).toBe("Joined 1 day ago");
    expect(formatJoined("2026-10-20T01:00:00Z", now)).toBe("Joined 5 days ago");
    expect(formatJoined("2019-03-10T01:00:00Z", now)).toMatch(
      /^Joined .*2019$/,
    );
  });
});
