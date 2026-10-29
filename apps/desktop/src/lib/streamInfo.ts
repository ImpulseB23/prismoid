// Formatting for the stream bar and the stream manager: compact viewer
// counts, uptime and countdown clocks, ad lengths and times of day.

import type { StreamInfo } from "./twitchChannel";

/** Unix ms the stream went live; null while offline or when unknown. */
export function liveSince(info: StreamInfo | null): number | null {
  if (!info?.is_live || info.started_at === null) return null;
  const ms = Date.parse(info.started_at);
  return Number.isNaN(ms) ? null : ms;
}

export function formatViewers(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatUptime(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "";
  const mins = Math.max(0, Math.floor((now - start) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

/** A running clock: "2:14:08", or "4:12" under an hour. */
export function formatClock(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs / 60) % 60;
  const s = (secs % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Ad lengths the way Twitch's dashboard says them: "90 sec", "3 min". */
export function formatAdLength(secs: number): string {
  return secs % 60 === 0 ? `${secs / 60} min` : `${secs} sec`;
}

/** Wall clock time in the user's locale, like "9:02 PM". */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
