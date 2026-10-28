// Live state for the active channel, refreshed on a timer while a channel
// is open. The last answer for each channel is kept, so switching back to a
// tab shows its bar at once while a fresh one loads; a channel seen for the
// first time reports loading so the bar can hold its place. The fetcher is
// injected so the store runs without a runtime; a generation counter drops
// responses from a channel that is no longer active.

import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { getStreamInfo, type StreamInfo } from "../lib/twitchChannel";
import { activeChannel } from "./channelStore";

export const STREAM_POLL_MS = 60_000;

export interface StreamStore {
  info: () => StreamInfo | null;
  /** True until the first answer for the active channel arrives. */
  loading: () => boolean;
  /** Wall clock at the last refresh, for uptime display. */
  now: () => number;
  /** Starts polling for the given channel id accessor. Call once at boot. */
  track: (channelId: () => string | undefined) => void;
}

export function createStreamStore(
  fetch: (channelId: string) => Promise<StreamInfo | null> = getStreamInfo,
  pollMs = STREAM_POLL_MS,
): StreamStore {
  const [info, setInfo] = createSignal<StreamInfo | null>(null);
  const [loading, setLoading] = createSignal(false);
  const known = new Map<string, StreamInfo | null>();
  const [now, setNow] = createSignal(Date.now());
  let generation = 0;

  function track(channelId: () => string | undefined): void {
    createEffect(
      on(channelId, (id) => {
        const gen = ++generation;
        if (id === undefined) {
          setInfo(null);
          setLoading(false);
          return;
        }
        setInfo(known.get(id) ?? null);
        setLoading(!known.has(id));
        const refresh = () => {
          fetch(id).then(
            (next) => {
              if (gen !== generation) return;
              known.set(id, next);
              setInfo(next);
              setLoading(false);
              setNow(Date.now());
            },
            (err: unknown) => {
              if (gen !== generation) return;
              console.error("stream info", err);
              setLoading(false);
            },
          );
        };
        refresh();
        const timer = setInterval(refresh, pollMs);
        onCleanup(() => clearInterval(timer));
      }),
    );
  }

  return { info, loading, now, track };
}

const defaultStore = createStreamStore();
export const streamInfo = defaultStore.info;
export const streamLoading = defaultStore.loading;
export const streamClock = defaultStore.now;
export function trackActiveStream(): void {
  defaultStore.track(() => activeChannel()?.id);
}
