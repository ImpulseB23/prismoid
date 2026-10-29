import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { AdBreak, AdSchedule } from "../../lib/ads";
import type { ScopeGroup } from "../../lib/twitchAuth";

const [schedule, setSchedule] = createSignal<AdSchedule | null>(null);
const [scheduleErr, setScheduleErr] = createSignal<unknown>(null);
const [adBreak, setAdBreak] = createSignal<AdBreak | null>(null);
const [readyAt, setReadyAt] = createSignal<number | null>(null);
const snooze = vi.fn(async () => true);
const commercial = vi.fn<(length: number) => Promise<boolean>>(
  async () => true,
);
vi.mock("../../stores/adStore", () => ({
  adSchedule: () => schedule(),
  adScheduleError: () => scheduleErr(),
  currentAdBreak: () => adBreak(),
  commercialReadyAt: () => readyAt(),
  commercialPending: () => false,
  snoozePending: () => false,
  snoozeNextAd: () => snooze(),
  startCommercial: (length: number) => commercial(length),
}));

const { default: AdsSection } = await import("./AdsSection");
const { setAuthStatus } = await import("../../stores/authStore");
const { recordStreamEvent, clearStreamLog } =
  await import("../../stores/streamLogStore");

const NOW = Date.UTC(2026, 9, 28, 22, 0);
const START = NOW - 3_600_000;

const signIn = (groups: ScopeGroup[]) =>
  setAuthStatus({
    state: "logged_in",
    login: "me",
    user_id: "7",
    missing_scopes: [],
    enabled_scope_groups: groups,
  });

const scheduled: AdSchedule = {
  next_ad_at: NOW + 252_000,
  last_ad_at: NOW - 1_800_000,
  duration: 90,
  preroll_free_time: 1080,
  snooze_count: 2,
  snooze_refresh_at: NOW + 2_040_000,
};

const ad = (over: Partial<AdBreak>): AdBreak => ({
  channel_id: "7",
  duration_seconds: 180,
  started_at: START + 600_000,
  is_automatic: false,
  requester_id: "7",
  requester_login: "me",
  requester_name: "Me",
  ...over,
});

describe("AdsSection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setSchedule(null);
    setScheduleErr(null);
    setAdBreak(null);
    setReadyAt(null);
    clearStreamLog();
    setAuthStatus(null);
  });

  it("explains ads until they are turned on", () => {
    signIn([]);
    render(() => <AdsSection now={NOW} since={START} />);
    expect(screen.getByText("Run your ads from here")).toBeTruthy();
    expect(screen.queryByText("Run an ad now")).toBeNull();
  });

  it("shows the schedule and runs an ad of the picked length", () => {
    signIn(["ads"]);
    setSchedule(scheduled);
    render(() => <AdsSection now={NOW} since={START} />);
    expect(screen.getByText("in 4:12")).toBeTruthy();
    expect(screen.getByText("90 sec break")).toBeTruthy();
    expect(screen.getByText("Another one in 34 min")).toBeTruthy();
    expect(screen.getByText("18 min")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("3 min"));
    fireEvent.click(screen.getByRole("button", { name: "Run 3 min ad" }));
    expect(commercial).toHaveBeenCalledWith(180);
    fireEvent.click(screen.getByRole("button", { name: "Snooze 5 min" }));
    expect(snooze).toHaveBeenCalledOnce();

    setReadyAt(NOW + 372_000);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Run 3 min ad" })
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/You can run another in 6:12/)).toBeTruthy();
  });

  it("lists the breaks seen this stream", () => {
    signIn(["ads"]);
    setSchedule(scheduled);
    recordStreamEvent({
      kind: "ad",
      id: "old",
      at: START - 60_000,
      ad: ad({ started_at: START - 60_000 }),
    });
    render(() => <AdsSection now={NOW} since={START} />);
    expect(
      screen.getByText(/Twitch says the last one started at/),
    ).toBeTruthy();

    const auto = ad({ started_at: START + 1_200_000, is_automatic: true });
    recordStreamEvent({ kind: "ad", id: "a", at: auto.started_at, ad: auto });
    expect(screen.getByText("Ad break, 3 min")).toBeTruthy();
    expect(screen.getByText("Automatic")).toBeTruthy();
    expect(screen.queryByText(/Twitch says/)).toBeNull();
  });

  it("covers offline, running and failed states", () => {
    signIn(["ads"]);
    render(() => <AdsSection now={NOW} since={null} />);
    expect(screen.getByText("Loading your ads")).toBeTruthy();
    setScheduleErr({ kind: "http", message: "" });
    expect(screen.getByText(/Could not reach Twitch/)).toBeTruthy();
    setSchedule({
      ...scheduled,
      next_ad_at: null,
      last_ad_at: null,
      preroll_free_time: 0,
    });
    expect(screen.getByText("None lined up")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Ads run while you are live.")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Run 90 sec ad" })
        .disabled,
    ).toBe(true);
    expect(screen.getByText("None yet since Prismoid opened.")).toBeTruthy();
    setAdBreak(ad({ started_at: NOW - 10_000 }));
    expect(screen.getByText("Running now")).toBeTruthy();
  });
});
