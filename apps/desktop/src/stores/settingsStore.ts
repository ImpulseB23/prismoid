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

const SETTINGS_KEY = "prismoid.settings";

export interface Settings {
  alwaysOnTop: boolean;
  zoom: number;
  showTimestamps: boolean;
  /** Logins whose messages are hidden from the feed. */
  ignoredLogins: string[];
  /** Extra words or phrases that highlight a message like a mention. */
  highlightPhrases: string[];
  /** Mark messages from accounts created in the last week. */
  flagNewAccounts: boolean;
  /** Private notes about chatters, by login. Never leave this device. */
  userNotes: Record<string, string>;
  /** Show moderator actions (timeouts, bans, mode changes) as rows in chat. */
  showModActions: boolean;
  /** Timeout lengths in seconds offered on rows, menus and the user card. */
  timeoutPresets: number[];
  /** Open the Twitch channel showing in the front browser window. */
  followBrowser: boolean;
  /** Fetch messages from before the join via the recent-messages service. */
  chatBacklog: boolean;
}

/** Twitch caps timeouts at two weeks. */
export const MAX_TIMEOUT_SECONDS = 1_209_600;
export const MAX_TIMEOUT_PRESETS = 8;

export const DEFAULT_SETTINGS: Settings = {
  alwaysOnTop: false,
  zoom: 1,
  showTimestamps: true,
  ignoredLogins: [],
  highlightPhrases: [],
  flagNewAccounts: true,
  userNotes: {},
  showModActions: true,
  timeoutPresets: [60, 600, 3600, 86_400],
  followBrowser: false,
  chatBacklog: true,
};

/** Same ladder browsers use between 75% and 200%. */
export const ZOOM_LEVELS = [0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2];

export interface SettingsAppliers {
  alwaysOnTop: (value: boolean) => Promise<void>;
  zoom: (value: number) => Promise<void>;
  followBrowser: (value: boolean) => Promise<void>;
  chatBacklog: (value: boolean) => Promise<void>;
}

export interface SettingsStore {
  settings: () => Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  zoomReset: () => Promise<void>;
  /** Re-applies persisted preferences to the live window. Call once at boot. */
  apply: () => Promise<void>;
}

const defaultAppliers: SettingsAppliers = {
  alwaysOnTop: (v) => getCurrentWindow().setAlwaysOnTop(v),
  zoom: (v) => getCurrentWebview().setZoom(v),
  followBrowser: (v) => invoke("set_browser_follow", { enabled: v }),
  chatBacklog: (v) => invoke("set_chat_backlog", { enabled: v }),
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
    setSettings(next);
    write(storage, SETTINGS_KEY, JSON.stringify(next));
  }

  function step(direction: 1 | -1): Promise<void> {
    const i = ZOOM_LEVELS.indexOf(settings().zoom);
    const idx = i === -1 ? ZOOM_LEVELS.indexOf(1) : i;
    const next = ZOOM_LEVELS[idx + direction];
    if (next === undefined) return Promise.resolve();
    return update({ zoom: next });
  }

  async function apply(): Promise<void> {
    const s = settings();
    if (s.alwaysOnTop) await appliers.alwaysOnTop(true);
    if (s.zoom !== 1) await appliers.zoom(s.zoom);
    if (s.followBrowser) await appliers.followBrowser(true);
    if (!s.chatBacklog) await appliers.chatBacklog(false);
  }

  return {
    settings,
    update,
    zoomIn: () => step(1),
    zoomOut: () => step(-1),
    zoomReset: () => update({ zoom: 1 }),
    apply,
  };
}

function readSettings(storage: StorageLike | null): Settings {
  const raw = read(storage, SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;
    const p = parsed as Record<string, unknown>;
    return {
      alwaysOnTop:
        typeof p.alwaysOnTop === "boolean"
          ? p.alwaysOnTop
          : DEFAULT_SETTINGS.alwaysOnTop,
      zoom:
        typeof p.zoom === "number" && ZOOM_LEVELS.includes(p.zoom)
          ? p.zoom
          : DEFAULT_SETTINGS.zoom,
      showTimestamps:
        typeof p.showTimestamps === "boolean"
          ? p.showTimestamps
          : DEFAULT_SETTINGS.showTimestamps,
      ignoredLogins: stringList(p.ignoredLogins),
      highlightPhrases: stringList(p.highlightPhrases),
      flagNewAccounts:
        typeof p.flagNewAccounts === "boolean"
          ? p.flagNewAccounts
          : DEFAULT_SETTINGS.flagNewAccounts,
      userNotes: stringMap(p.userNotes),
      showModActions:
        typeof p.showModActions === "boolean"
          ? p.showModActions
          : DEFAULT_SETTINGS.showModActions,
      timeoutPresets: durationList(p.timeoutPresets),
      followBrowser:
        typeof p.followBrowser === "boolean"
          ? p.followBrowser
          : DEFAULT_SETTINGS.followBrowser,
      chatBacklog:
        typeof p.chatBacklog === "boolean"
          ? p.chatBacklog
          : DEFAULT_SETTINGS.chatBacklog,
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

function stringMap(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) out[k] = val;
  }
  return out;
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

export function noteFor(login: string): string {
  return settings().userNotes[login] ?? "";
}

/** Saves a trimmed note, or removes the entry when the note is blank. */
export function setNote(login: string, text: string): Promise<void> {
  const trimmed = text.trim();
  const current = settings().userNotes;
  if ((current[login] ?? "") === trimmed) return Promise.resolve();
  const next = { ...current };
  if (trimmed) next[login] = trimmed;
  else delete next[login];
  return updateSettings({ userNotes: next });
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
