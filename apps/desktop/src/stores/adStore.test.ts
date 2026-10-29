import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdBreak, AdSchedule } from "../lib/ads";
import { AD_REFRESH_MS, createAdStore, type AdsApi } from "./adStore";

const NOW = 1_700_000_000_000;

const schedule = (over: Partial<AdSchedule> = {}): AdSchedule => ({
  next_ad_at: NOW + 600_000,
  last_ad_at: null,
  duration: 60,
  preroll_free_time: 0,
  snooze_count: 3,
  snooze_refresh_at: null,
  ...over,
});

const adBreak = (over: Partial<AdBreak> = {}): AdBreak => ({
  channel_id: "7",
  duration_seconds: 60,
  started_at: NOW,
  is_automatic: true,
  requester_id: "7",
  requester_login: "me",
  requester_name: "Me",
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeApi(over: Partial<AdsApi> = {}): AdsApi {
  return {
    getAdSchedule: vi.fn(async () => schedule()),
    snoozeNextAd: vi.fn(async () => ({
      next_ad_at: NOW + 900_000,
      snooze_count: 2,
      snooze_refresh_at: NOW + 3_600_000,
    })),
    startCommercial: vi.fn(async (length: number) => ({
      length,
      message: "",
      retry_after: 480,
    })),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("adStore", () => {
  it("loads the schedule for the signed-in user", async () => {
    const s = createAdStore(fakeApi(), () => "7");
    await s.load();
    expect(s.schedule()).toEqual(schedule());
    expect(s.loading()).toBe(false);
    expect(s.loadError()).toBeNull();
  });

  it("does nothing while signed out", async () => {
    const api = fakeApi();
    const s = createAdStore(api, () => null);
    await s.load();
    expect(api.getAdSchedule).not.toHaveBeenCalled();
  });

  it("keeps a load error and the last schedule", async () => {
    const denied = { kind: "helix", status: 401, message: "missing scope" };
    const api = fakeApi();
    const s = createAdStore(api, () => "7");
    await s.load();
    vi.mocked(api.getAdSchedule).mockRejectedValueOnce(denied);
    await s.load();
    expect(s.loadError()).toEqual(denied);
    expect(s.schedule()).toEqual(schedule());
  });

  it("refreshes on a timer only while tracked", async () => {
    const api = fakeApi();
    const s = createAdStore(api, () => "7");
    const stopA = s.track();
    const stopB = s.track();
    expect(api.getAdSchedule).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AD_REFRESH_MS * 2);
    expect(api.getAdSchedule).toHaveBeenCalledTimes(3);

    stopA();
    stopA();
    await vi.advanceTimersByTimeAsync(AD_REFRESH_MS);
    expect(api.getAdSchedule).toHaveBeenCalledTimes(4);
    stopB();
    await vi.advanceTimersByTimeAsync(AD_REFRESH_MS * 3);
    expect(api.getAdSchedule).toHaveBeenCalledTimes(4);
  });

  it("lets only the newest load land", async () => {
    const slow = deferred<AdSchedule>();
    const api = fakeApi({
      getAdSchedule: vi
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce(schedule({ snooze_count: 1 })),
    });
    const s = createAdStore(api, () => "7");
    const first = s.load();
    await s.load();
    slow.resolve(schedule({ snooze_count: 3 }));
    await first;
    expect(s.schedule()?.snooze_count).toBe(1);
    expect(s.loading()).toBe(false);
  });

  it("snoozes, applies the new times and reloads", async () => {
    const gate = deferred<AdSchedule>();
    const api = fakeApi();
    const s = createAdStore(api, () => "7");
    await s.load();
    vi.mocked(api.getAdSchedule).mockReturnValueOnce(gate.promise);
    const done = s.snooze();
    expect(s.snoozePending()).toBe(true);
    expect(await done).toBe(true);
    expect(s.snoozePending()).toBe(false);
    expect(s.schedule()).toEqual(
      schedule({
        next_ad_at: NOW + 900_000,
        snooze_count: 2,
        snooze_refresh_at: NOW + 3_600_000,
      }),
    );
    expect(api.getAdSchedule).toHaveBeenCalledTimes(2);
    gate.resolve(schedule({ snooze_count: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.schedule()?.snooze_count).toBe(2);
  });

  it("surfaces a refused snooze", async () => {
    const err = { kind: "no_snoozes_left", message: "" };
    const s = createAdStore(
      fakeApi({
        snoozeNextAd: async () => {
          throw err;
        },
      }),
      () => "7",
    );
    expect(await s.snooze()).toBe(false);
    expect(s.snoozeError()).toEqual(err);
    expect(s.snoozePending()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.schedule()?.snooze_count).toBe(3);
  });

  it("starts a commercial and knows when the next may run", async () => {
    const api = fakeApi();
    const s = createAdStore(api, () => "7");
    expect(await s.startCommercial(90)).toBe(true);
    expect(api.startCommercial).toHaveBeenCalledWith(90);
    expect(s.commercialReadyAt()).toBe(NOW + 480_000);
    expect(s.commercialPending()).toBe(false);
    expect(api.getAdSchedule).toHaveBeenCalledTimes(1);
  });

  it("takes the retry time from a cooldown error", async () => {
    const cooldown = {
      kind: "commercial_cooldown",
      message: "",
      retry_at: NOW + 200_000,
    };
    const api = fakeApi({
      startCommercial: vi.fn().mockRejectedValueOnce(cooldown),
    });
    const s = createAdStore(api, () => "7");
    expect(await s.startCommercial(30)).toBe(false);
    expect(s.commercialError()).toEqual(cooldown);
    expect(s.commercialReadyAt()).toBe(NOW + 200_000);

    const notLive = { kind: "helix", status: 400, message: "not live" };
    vi.mocked(api.startCommercial).mockRejectedValueOnce(notLive);
    expect(await s.startCommercial(30)).toBe(false);
    expect(s.commercialError()).toEqual(notLive);
    expect(s.commercialReadyAt()).toBe(NOW + 200_000);
  });

  it("shows an ad break until it ends, then reloads", async () => {
    const api = fakeApi();
    const s = createAdStore(api, () => "7");
    s.applyAdBreak(adBreak({ started_at: NOW - 10_000 }));
    expect(s.adBreak()?.duration_seconds).toBe(60);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(s.adBreak()).not.toBeNull();
    expect(api.getAdSchedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.adBreak()).toBeNull();
    expect(api.getAdSchedule).toHaveBeenCalledTimes(1);
  });

  it("lets a newer ad break replace the running one", async () => {
    const s = createAdStore(fakeApi(), () => "7");
    s.applyAdBreak(adBreak({ duration_seconds: 30 }));
    s.applyAdBreak(adBreak({ duration_seconds: 90, is_automatic: false }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.adBreak()?.is_automatic).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.adBreak()).toBeNull();
  });

  it("ignores ad breaks from other channels and ones already over", () => {
    const s = createAdStore(fakeApi(), () => "7");
    s.applyAdBreak(adBreak({ channel_id: "8" }));
    s.applyAdBreak(adBreak({ started_at: NOW - 60_000 }));
    expect(s.adBreak()).toBeNull();
  });

  it("drops everything on clear, including results in flight", async () => {
    const gate = deferred<AdSchedule>();
    const s = createAdStore(
      fakeApi({ getAdSchedule: () => gate.promise }),
      () => "7",
    );
    s.applyAdBreak(adBreak());
    const loading = s.load();
    s.clear();
    gate.resolve(schedule());
    await loading;
    expect(s.schedule()).toBeNull();
    expect(s.adBreak()).toBeNull();
    expect(s.loading()).toBe(false);
  });
});
