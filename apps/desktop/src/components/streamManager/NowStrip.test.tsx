import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { AdBreak, AdSchedule } from "../../lib/ads";
import type { StreamInfo } from "../../lib/twitchChannel";

const [schedule, setSchedule] = createSignal<AdSchedule | null>(null);
const [adBreak, setAdBreak] = createSignal<AdBreak | null>(null);
const [readyAt, setReadyAt] = createSignal<number | null>(null);
const [snoozeErr, setSnoozeErr] = createSignal<unknown>(null);
const snooze = vi.fn(async () => true);
const commercial = vi.fn<(length: number) => Promise<boolean>>(
  async () => true,
);
vi.mock("../../stores/adStore", () => ({
  adSchedule: () => schedule(),
  currentAdBreak: () => adBreak(),
  commercialReadyAt: () => readyAt(),
  snoozeError: () => snoozeErr(),
  commercialError: () => null,
  snoozePending: () => false,
  commercialPending: () => false,
  snoozeNextAd: () => snooze(),
  startCommercial: (length: number) => commercial(length),
}));
vi.mock("../../stores/streamLogStore", () => ({ streamLog: () => [] }));

const { default: NowStrip } = await import("./NowStrip");

const START = Date.UTC(2026, 9, 28, 20, 0);
const NOW = START + 8_048_000;

const live: StreamInfo = {
  is_live: true,
  title: "ranked",
  game_name: "League of Legends",
  viewer_count: 1204,
  started_at: new Date(START).toISOString(),
};

const scheduled: AdSchedule = {
  next_ad_at: NOW + 252_000,
  last_ad_at: null,
  duration: 90,
  preroll_free_time: 0,
  snooze_count: 2,
  snooze_refresh_at: null,
};

describe("NowStrip", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setSchedule(null);
    setAdBreak(null);
    setReadyAt(null);
    setSnoozeErr(null);
  });

  it("shows offline without a clock or ads", () => {
    render(() => (
      <NowStrip info={{ ...live, is_live: false }} now={NOW} adsReady />
    ));
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText("Watching")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("list", { name: "Stream timeline" })).toBeNull();
  });

  it("shows uptime, viewers and the timeline while live", () => {
    render(() => <NowStrip info={live} now={NOW} adsReady={false} />);
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("2:14:08")).toBeTruthy();
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Stream timeline" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("counts down to the next ad and snoozes or runs one", () => {
    setSchedule(scheduled);
    render(() => <NowStrip info={live} now={NOW} adsReady />);
    expect(screen.getByText("Next ad, 90 sec")).toBeTruthy();
    expect(screen.getByText("in 4:12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Snooze 5 min" }));
    expect(snooze).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Run 90 sec ad" }));
    expect(commercial).toHaveBeenCalledWith(90);

    setSchedule({ ...scheduled, snooze_count: 0 });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Snooze 5 min" })
        .disabled,
    ).toBe(true);
    setReadyAt(NOW + 60_000);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Run 90 sec ad" })
        .disabled,
    ).toBe(true);
  });

  it("shows a running ad break and why an action failed", () => {
    setAdBreak({
      channel_id: "7",
      duration_seconds: 90,
      started_at: NOW - 18_000,
      is_automatic: true,
      requester_id: "7",
      requester_login: "me",
      requester_name: "Me",
    });
    setSnoozeErr({ kind: "no_snoozes_left", message: "" });
    render(() => <NowStrip info={live} now={NOW} adsReady />);
    expect(screen.getByText("Ad running")).toBeTruthy();
    expect(screen.getByText("1:12 left")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("No snoozes left");
  });
});
