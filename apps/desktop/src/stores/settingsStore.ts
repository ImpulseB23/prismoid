// User preferences that persist across launches: window pinning, zoom
// level and chat appearance. Window and webview calls are injected so the
// store can run without a Tauri runtime; storage is injected for the same
// reason (no global mutation in tests).

import { createSignal } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import type { StorageLike } from "./channelStore";
import { parseDuration } from "../lib/slashCommands";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES } from "../lib/messageLayout";
import { baseZoom, snapTo, TARGET_UI_SCALE } from "../lib/uiScale";

const SETTINGS_KEY = "prismoid.settings";
// Bumped when a stored value changes meaning. 2: zoom and text size became
// relative to the bigger intended size (zoom 1 and text 20 are the new 100%).
const SETTINGS_VERSION = 2;
// Text sizes before version 2 used 15px as their 100%.
const LEGACY_TEXT_DEFAULT = 15;

export interface Settings {
  alwaysOnTop: boolean;
  /** Whole-window zoom on top of the display-aware base (see uiScale). */
  zoom: number;
  /** Chat message size in px, one of TEXT_SIZES. */
  textSize: number;
  showTimestamps: boolean;
  /** Shade every other row so long chats are easier to follow. */
  alternateRows: boolean;
  /** Logins whose messages are hidden from the feed. */
  ignoredLogins: string[];
  /** Logins whose every message is highlighted. */
  highlightUsers: string[];
  /** Badge sets (streamer, mods, VIPs, subs) whose messages are highlighted. */
  highlightBadges: HighlightBadge[];
  /** Extra words or phrases that highlight a message like a mention. */
  highlightPhrases: string[];
  /** Fill usernames with the 7TV paint the chatter picked. */
  showPaints: boolean;
  /** Mark messages from accounts created in the last week. */
  flagNewAccounts: boolean;
  /** Show moderator actions (timeouts, bans, mode changes) as rows in chat. */
  showModActions: boolean;
  /** Timeout lengths in seconds offered on rows, menus and the user card. */
  timeoutPresets: number[];
  /** Slow mode wait the Modes panel switches on with, in seconds. */
  defaultSlowSeconds: number;
  /** Follow age the Modes panel switches followers-only on with, in minutes. */
  defaultFollowerMinutes: number;
  /** Open the Twitch channel showing in the front browser window. */
  followBrowser: boolean;
  /** Fetch messages from before the join via the recent-messages service. */
  chatBacklog: boolean;
  /** Closing the window leaves Prismoid running in the tray. */
  closeToTray: boolean;
  /** Mark a chatter's first message in a channel. */
  highlightFirstMessages: boolean;
  /** The welcome tour has been finished or skipped. */
  tourDone: boolean;
  /** Chime and flash the taskbar when mentioned in the background. */
  mentionAlerts: boolean;
  theme: Theme;
}

export type Theme = "system" | "dark" | "midnight" | "light" | "prismoid";
export const THEMES: Theme[] = [
  "system",
  "dark",
  "midnight",
  "light",
  "prismoid",
];

export const HIGHLIGHT_BADGES = [
  "broadcaster",
  "moderator",
  "vip",
  "subscriber",
] as const;
export type HighlightBadge = (typeof HIGHLIGHT_BADGES)[number];

/** Twitch caps timeouts at two weeks. */
export const MAX_TIMEOUT_SECONDS = 1_209_600;
export const MAX_TIMEOUT_PRESETS = 8;

export const DEFAULT_SETTINGS: Settings = {
  alwaysOnTop: false,
  zoom: 1,
  textSize: DEFAULT_TEXT_SIZE,
  showTimestamps: false,
  alternateRows: false,
  ignoredLogins: [],
  highlightUsers: [],
  highlightBadges: [],
  highlightPhrases: [],
  showPaints: true,
  flagNewAccounts: true,
  showModActions: true,
  timeoutPresets: [60, 600, 3600, 86_400],
  defaultSlowSeconds: 5,
  defaultFollowerMinutes: 0,
  followBrowser: false,
  chatBacklog: true,
  closeToTray: false,
  highlightFirstMessages: true,
  tourDone: false,
  mentionAlerts: true,
  theme: "dark",
};

/** Same ladder browsers use between 75% and 200%. */
export const ZOOM_LEVELS = [
  0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

export interface SettingsAppliers {
  alwaysOnTop: (value: boolean) => Promise<void>;
  zoom: (value: number) => Promise<void>;
  followBrowser: (value: boolean) => Promise<void>;
  chatBacklog: (value: boolean) => Promise<void>;
  closeToTray: (value: boolean) => Promise<void>;
  highlightFirstMessages: (value: boolean) => Promise<void>;
  showPaints: (value: boolean) => Promise<void>;
  theme: (value: Theme) => Promise<void>;
}

export interface SettingsStore {
  settings: () => Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  zoomReset: () => Promise<void>;
  textBigger: () => Promise<void>;
  textSmaller: () => Promise<void>;
  textReset: () => Promise<void>;
  /** Re-applies persisted preferences to the live window. Call once at boot. */
  apply: () => Promise<void>;
  /** Re-applies zoom, for when the window moves to a display with another scale. */
  reapplyZoom: () => Promise<void>;
}

const defaultAppliers: SettingsAppliers = {
  alwaysOnTop: (v) => getCurrentWindow().setAlwaysOnTop(v),
  zoom: async (v) =>
    getCurrentWebview().setZoom(
      v * baseZoom(await getCurrentWindow().scaleFactor()),
    ),
  followBrowser: (v) => invoke("set_browser_follow", { enabled: v }),
  chatBacklog: (v) => invoke("set_chat_backlog", { enabled: v }),
  closeToTray: (v) => invoke("set_close_to_tray", { enabled: v }),
  highlightFirstMessages: (v) => invoke("set_first_messages", { enabled: v }),
  showPaints: (v) => invoke("set_seventv_paints", { enabled: v }),
  // "system" hands the title bar back to Windows; midnight shares dark chrome.
  theme: (v) =>
    getCurrentWindow().setTheme(
      v === "system" ? null : v === "light" ? "light" : "dark",
    ),
};

export function createSettingsStore(
  appliers: SettingsAppliers = defaultAppliers,
  storage: StorageLike | null = defaultStorage(),
): SettingsStore {
  const [settings, setSettings] = createSignal<Settings>(readSettings(storage));

  async function update(patch: Partial<Settings>): Promise<void> {
    const current = settings();
    const next = { ...current, ...patch };
    // Apply before committing so a failed window call leaves state
    // untouched and the UI never shows a toggle the window didn't take.
    if (next.alwaysOnTop !== current.alwaysOnTop) {
      await appliers.alwaysOnTop(next.alwaysOnTop);
    }
    if (next.zoom !== current.zoom) {
      await appliers.zoom(next.zoom);
    }
    if (next.followBrowser !== current.followBrowser) {
      await appliers.followBrowser(next.followBrowser);
    }
    if (next.chatBacklog !== current.chatBacklog) {
      await appliers.chatBacklog(next.chatBacklog);
    }
    if (next.closeToTray !== current.closeToTray) {
      await appliers.closeToTray(next.closeToTray);
    }
    if (next.highlightFirstMessages !== current.highlightFirstMessages) {
      await appliers.highlightFirstMessages(next.highlightFirstMessages);
    }
    if (next.showPaints !== current.showPaints) {
      await appliers.showPaints(next.showPaints);
    }
    if (next.theme !== current.theme) {
      await appliers.theme(next.theme);
    }
    setSettings(next);
    write(
      storage,
      SETTINGS_KEY,
      JSON.stringify({ ...next, v: SETTINGS_VERSION }),
    );
  }

  function step(
    key: "zoom" | "textSize",
    ladder: number[],
    direction: 1 | -1,
  ): Promise<void> {
    const i = ladder.indexOf(settings()[key]);
    const idx = i === -1 ? ladder.indexOf(DEFAULT_SETTINGS[key]) : i;
    const next = ladder[idx + direction];
    if (next === undefined) return Promise.resolve();
    return update({ [key]: next });
  }

  async function apply(): Promise<void> {
    const s = settings();
    if (s.alwaysOnTop) await appliers.alwaysOnTop(true);
    await appliers.zoom(s.zoom);
    if (s.followBrowser) await appliers.followBrowser(true);
    if (!s.chatBacklog) await appliers.chatBacklog(false);
    if (s.closeToTray) await appliers.closeToTray(true);
    if (!s.highlightFirstMessages) await appliers.highlightFirstMessages(false);
    if (!s.showPaints) await appliers.showPaints(false);
    if (s.theme !== "system") await appliers.theme(s.theme);
  }

  return {
    settings,
    update,
    zoomIn: () => step("zoom", ZOOM_LEVELS, 1),
    zoomOut: () => step("zoom", ZOOM_LEVELS, -1),
    zoomReset: () => update({ zoom: 1 }),
    textBigger: () => step("textSize", TEXT_SIZES, 1),
    textSmaller: () => step("textSize", TEXT_SIZES, -1),
    textReset: () => update({ textSize: DEFAULT_TEXT_SIZE }),
    apply,
    reapplyZoom: () => appliers.zoom(settings().zoom),
  };
}

function readSettings(storage: StorageLike | null): Settings {
  const raw = read(storage, SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    const p = parsed as Record<string, unknown>;
    const legacy = p.v !== SETTINGS_VERSION;
    return {
      alwaysOnTop:
        typeof p.alwaysOnTop === "boolean"
          ? p.alwaysOnTop
          : DEFAULT_SETTINGS.alwaysOnTop,
      zoom: readZoom(p.zoom, legacy),
      textSize: readTextSize(p.textSize, legacy),
      showTimestamps:
        typeof p.showTimestamps === "boolean"
          ? p.showTimestamps
          : DEFAULT_SETTINGS.showTimestamps,
      alternateRows:
        typeof p.alternateRows === "boolean"
          ? p.alternateRows
          : DEFAULT_SETTINGS.alternateRows,
      ignoredLogins: stringList(p.ignoredLogins),
      highlightUsers: stringList(p.highlightUsers),
      highlightBadges: stringList(p.highlightBadges).filter(
        (b): b is HighlightBadge =>
          HIGHLIGHT_BADGES.includes(b as HighlightBadge),
      ),
      highlightPhrases: stringList(p.highlightPhrases),
      showPaints:
        typeof p.showPaints === "boolean"
          ? p.showPaints
          : DEFAULT_SETTINGS.showPaints,
      flagNewAccounts:
        typeof p.flagNewAccounts === "boolean"
          ? p.flagNewAccounts
          : DEFAULT_SETTINGS.flagNewAccounts,
      showModActions:
        typeof p.showModActions === "boolean"
          ? p.showModActions
          : DEFAULT_SETTINGS.showModActions,
      timeoutPresets: durationList(p.timeoutPresets),
      defaultSlowSeconds:
        intIn(p.defaultSlowSeconds, 1, 120) ??
        DEFAULT_SETTINGS.defaultSlowSeconds,
      defaultFollowerMinutes:
        intIn(p.defaultFollowerMinutes, 0, 129_600) ??
        DEFAULT_SETTINGS.defaultFollowerMinutes,
      followBrowser:
        typeof p.followBrowser === "boolean"
          ? p.followBrowser
          : DEFAULT_SETTINGS.followBrowser,
      chatBacklog:
        typeof p.chatBacklog === "boolean"
          ? p.chatBacklog
          : DEFAULT_SETTINGS.chatBacklog,
      closeToTray:
        typeof p.closeToTray === "boolean"
          ? p.closeToTray
          : DEFAULT_SETTINGS.closeToTray,
      highlightFirstMessages:
        typeof p.highlightFirstMessages === "boolean"
          ? p.highlightFirstMessages
          : DEFAULT_SETTINGS.highlightFirstMessages,
      tourDone:
        typeof p.tourDone === "boolean"
          ? p.tourDone
          : DEFAULT_SETTINGS.tourDone,
      mentionAlerts:
        typeof p.mentionAlerts === "boolean"
          ? p.mentionAlerts
          : DEFAULT_SETTINGS.mentionAlerts,
      theme:
        typeof p.theme === "string" && THEMES.includes(p.theme as Theme)
          ? (p.theme as Theme)
          : DEFAULT_SETTINGS.theme,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string")
    : [];
}

/** Keeps valid, distinct timeout lengths in the given order; falls back to the defaults when none survive. */
function durationList(v: unknown): number[] {
  if (!Array.isArray(v)) return DEFAULT_SETTINGS.timeoutPresets;
  const out: number[] = [];
  for (const n of v) {
    if (
      typeof n === "number" &&
      Number.isInteger(n) &&
      n >= 1 &&
      n <= MAX_TIMEOUT_SECONDS &&
      !out.includes(n)
    ) {
      out.push(n);
    }
    if (out.length === MAX_TIMEOUT_PRESETS) break;
  }
  return out.length > 0 ? out : DEFAULT_SETTINGS.timeoutPresets;
}

/**
 * Parses "1m, 10m, 1h, 1d" (or plain seconds) into timeout presets. Entries
 * that do not parse or fall outside Twitch's range are dropped; null when
 * nothing usable remains so the caller can keep the previous list.
 */
export function parseDurations(raw: string): number[] | null {
  const parsed = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseDuration(s));
  const list = durationList(parsed);
  return parsed.some((n) => n !== null) ? list : null;
}

function read(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // best-effort persistence
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const defaultStore = createSettingsStore();

export const settings = defaultStore.settings;
export const updateSettings = defaultStore.update;
export const zoomIn = defaultStore.zoomIn;
export const zoomOut = defaultStore.zoomOut;
export const zoomReset = defaultStore.zoomReset;
export const reapplyZoom = defaultStore.reapplyZoom;
export const textBigger = defaultStore.textBigger;
export const textSmaller = defaultStore.textSmaller;
export const textReset = defaultStore.textReset;
export const applyWindowSettings = defaultStore.apply;

/** Splits a comma or newline separated list into trimmed, deduped entries. */
export function parseList(raw: string, lowercase = false): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const s = lowercase ? part.trim().toLowerCase() : part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function isIgnored(login: string): boolean {
  return settings().ignoredLogins.includes(login);
}

export function setIgnored(login: string, ignored: boolean): Promise<void> {
  const current = settings().ignoredLogins;
  const next = ignored
    ? current.includes(login)
      ? current
      : [...current, login]
    : current.filter((l) => l !== login);
  return next === current
    ? Promise.resolve()
    : updateSettings({ ignoredLogins: next });
}

export function isUserHighlighted(login: string): boolean {
  return settings().highlightUsers.includes(login);
}

export function setUserHighlighted(login: string, on: boolean): Promise<void> {
  const current = settings().highlightUsers;
  if (current.includes(login) === on) return Promise.resolve();
  return updateSettings({
    highlightUsers: on
      ? [...current, login]
      : current.filter((l) => l !== login),
  });
}

// Before version 2 zoom was the raw webview factor. Someone who never
// changed it starts at the new default; anyone who did keeps roughly the
// size they chose, read against the base an unscaled display gets.
function readZoom(v: unknown, legacy: boolean): number {
  if (typeof v !== "number") return DEFAULT_SETTINGS.zoom;
  if (!legacy) return ZOOM_LEVELS.includes(v) ? v : DEFAULT_SETTINGS.zoom;
  return v === 1
    ? DEFAULT_SETTINGS.zoom
    : snapTo(ZOOM_LEVELS, v / TARGET_UI_SCALE);
}

function readTextSize(v: unknown, legacy: boolean): number {
  if (typeof v !== "number") return DEFAULT_SETTINGS.textSize;
  if (!legacy) return TEXT_SIZES.includes(v) ? v : DEFAULT_SETTINGS.textSize;
  return snapTo(TEXT_SIZES, (v * DEFAULT_TEXT_SIZE) / LEGACY_TEXT_DEFAULT);
}

// Twitch accepts slow mode from 1 to 120 seconds and follower age up to
// three months.
function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
    ? v
    : null;
}
