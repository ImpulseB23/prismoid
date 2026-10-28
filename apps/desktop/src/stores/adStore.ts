// Ad state for the signed-in broadcaster's own channel: the schedule from
// Helix, the ad break running now from EventSub, and snooze and commercial
// actions with their own pending flag and error. The schedule refreshes on
// a timer while anything tracks it, after each action and when an ad break
// ends. The commands and the owner id are injected for tests.

import { createSignal } from "solid-js";
import * as api from "../lib/ads";
import type { AdBreak, AdSchedule } from "../lib/ads";
import { isChannelError } from "../lib/twitchChannel";
import { currentUserId } from "./authStore";

export type AdsApi = Pick<
  typeof api,
  "getAdSchedule" | "snoozeNextAd" | "startCommercial"
>;

export const AD_REFRESH_MS = 60_000;

export interface AdStore {
  schedule: () => AdSchedule | null;
  /** The ad break running now; null once it is over. */
  adBreak: () => AdBreak | null;
  /** Unix ms when the next commercial may run, when known. */
  commercialReadyAt: () => number | null;
  loading: () => boolean;
  loadError: () => unknown;
  snoozePending: () => boolean;
  snoozeError: () => unknown;
  commercialPending: () => boolean;
  commercialError: () => unknown;
  /** Reads the schedule for the signed-in user. */
  load: () => Promise<void>;
  /** Loads now and every AD_REFRESH_MS until every tracker has stopped. */
  track: () => () => void;
  /** The actions resolve true once Twitch accepted them. */
  snooze: () => Promise<boolean>;
  startCommercial: (length: number) => Promise<boolean>;
  /** Live update from EventSub; ignored unless it is the user's channel. */
  applyAdBreak: (ad: AdBreak) => void;
  clear: () => void;
}

export function createAdStore(
  commands: AdsApi = api,
  ownerId: () => string | null = currentUserId,
  now: () => number = Date.now,
): AdStore {
  const [schedule, setSchedule] = createSignal<AdSchedule | null>(null);
  const [adBreak, setAdBreak] = createSignal<AdBreak | null>(null);
  const [commercialReadyAt, setCommercialReadyAt] = createSignal<number | null>(
    null,
  );
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<unknown>(null);
  const [snoozePending, setSnoozePending] = createSignal(false);
  const [snoozeError, setSnoozeError] = createSignal<unknown>(null);
  const [commercialPending, setCommercialPending] = createSignal(false);
  const [commercialError, setCommercialError] = createSignal<unknown>(null);
  // Bumped by clear() so nothing in flight writes into a signed-out store.
  let generation = 0;
  // Only the newest load lands, so a slow one never undoes a snooze.
  let loadSeq = 0;
  let trackers = 0;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let breakEnd: ReturnType<typeof setTimeout> | undefined;

  async function load(): Promise<void> {
    if (ownerId() === null) return;
    const gen = generation;
    const seq = ++loadSeq;
    setLoading(true);
    try {
      const next = await commands.getAdSchedule();
      if (gen !== generation || seq !== loadSeq) return;
      setSchedule(next);
      setLoadError(null);
    } catch (e) {
      if (gen === generation && seq === loadSeq) setLoadError(e);
    } finally {
      if (gen === generation && seq === loadSeq) setLoading(false);
    }
  }

  function track(): () => void {
    if (trackers++ === 0) {
      void load();
      refresh = setInterval(() => void load(), AD_REFRESH_MS);
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--trackers === 0) clearInterval(refresh);
    };
  }

  async function run<T>(
    setPending: (v: boolean) => void,
    setError: (e: unknown) => void,
    call: () => Promise<T>,
    done: (value: T) => void,
    failed: (e: unknown) => void = () => {},
  ): Promise<boolean> {
    const gen = generation;
    setPending(true);
    setError(null);
    try {
      const value = await call();
      if (gen === generation) done(value);
      return true;
    } catch (e) {
      if (gen === generation) {
        setError(e);
        failed(e);
      }
      return false;
    } finally {
      if (gen === generation) {
        setPending(false);
        void load();
      }
    }
  }

  function applyAdBreak(ad: AdBreak): void {
    if (ad.channel_id !== ownerId()) return;
    const left = ad.started_at + ad.duration_seconds * 1000 - now();
    if (left <= 0) return;
    clearTimeout(breakEnd);
    setAdBreak(ad);
    breakEnd = setTimeout(() => {
      setAdBreak(null);
      void load();
    }, left);
  }

  return {
    schedule,
    adBreak,
    commercialReadyAt,
    loading,
    loadError,
    snoozePending,
    snoozeError,
    commercialPending,
    commercialError,
    load,
    track,
    snooze: () =>
      run(setSnoozePending, setSnoozeError, commands.snoozeNextAd, (s) => {
        const current = schedule();
        if (current) setSchedule({ ...current, ...s });
      }),
    startCommercial: (length) =>
      run(
        setCommercialPending,
        setCommercialError,
        () => commands.startCommercial(length),
        (c) => setCommercialReadyAt(now() + c.retry_after * 1000),
        (e) => {
          if (isChannelError(e) && e.kind === "commercial_cooldown")
            setCommercialReadyAt(e.retry_at);
        },
      ),
    applyAdBreak,
    clear: () => {
      generation++;
      clearTimeout(breakEnd);
      setSchedule(null);
      setAdBreak(null);
      setCommercialReadyAt(null);
      setLoading(false);
      setLoadError(null);
      setSnoozePending(false);
      setSnoozeError(null);
      setCommercialPending(false);
      setCommercialError(null);
    },
  };
}

const defaultStore = createAdStore();
export const adSchedule = defaultStore.schedule;
export const currentAdBreak = defaultStore.adBreak;
export const commercialReadyAt = defaultStore.commercialReadyAt;
export const adScheduleLoading = defaultStore.loading;
export const adScheduleError = defaultStore.loadError;
export const snoozePending = defaultStore.snoozePending;
export const snoozeError = defaultStore.snoozeError;
export const commercialPending = defaultStore.commercialPending;
export const commercialError = defaultStore.commercialError;
export const loadAdSchedule = defaultStore.load;
export const trackAdSchedule = defaultStore.track;
export const snoozeNextAd = defaultStore.snooze;
export const startCommercial = defaultStore.startCommercial;
export const applyAdBreak = defaultStore.applyAdBreak;
export const clearAds = defaultStore.clear;
