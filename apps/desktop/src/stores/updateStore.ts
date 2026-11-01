// App updates through the Tauri updater while prismoid runs: checks every
// half hour, on focus and from Settings that download quietly and then
// offer a restart. Updates found at launch are the startup window's job
// (see launchUpdate); a launch without it, like autostart into the tray,
// checks here. The plugin calls are injected so the store runs without a
// runtime.

import { createSignal } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { palette } from "./themeStore";

export const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Coming back to the window checks again once the last check is this old. */
export const FOCUS_RECHECK_MS = 5 * 60 * 1000;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; checkedAt: number }
  | { kind: "available"; version: string; notes: string | null }
  /** Fetched in the background; installing only needs the restart. */
  | { kind: "downloaded"; version: string; notes: string | null }
  | {
      kind: "downloading";
      version: string;
      received: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string; during: "check" | "install" };

/** The slice of the plugin's update object the store needs. */
export interface PendingUpdate {
  version: string;
  body?: string;
  download: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
  /** Runs the downloaded installer; only after download resolves. */
  install: () => Promise<void>;
}

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdateStore {
  state: () => UpdateState;
  /** Looks for a newer version. Errors are shown only for a manual check. */
  check: (manual: boolean) => Promise<void>;
  /** Installs the found update, downloading it first if the background
   * download has not finished, then restarts. */
  install: () => Promise<void>;
  /** Puts a failed install back to "available" so the nudge stays. */
  dismiss: () => void;
  /** Runs the launch check now, then the interval and focus checks;
   * returns a stop function. */
  schedule: () => () => void;
}

export function createUpdateStore(
  lookup: () => Promise<PendingUpdate | null> = findUpdate,
  restart: () => Promise<void> = relaunch,
  now: () => number = Date.now,
  onFocus: (cb: () => void) => () => void = windowFocus,
  cover: () => Promise<void> = startUpdateSplash,
  checkedAtLaunch: () => Promise<boolean> = () => invoke("launch_update_ran"),
): UpdateStore {
  const [state, setState] = createSignal<UpdateState>({ kind: "idle" });
  let pending: PendingUpdate | null = null;
  let generation = 0;
  let lastCheckAt = 0;
  // The quiet download of `pending`, with its progress so far. Installing
  // while it runs waits on it instead of fetching the file twice.
  let quiet: Promise<void> | null = null;
  let fetched = false;
  let received = 0;
  let total: number | null = null;
  let onProgress: (() => void) | null = null;

  function startFetch(update: PendingUpdate): Promise<void> {
    fetched = false;
    received = 0;
    total = null;
    const run = update
      .download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }
        onProgress?.();
      })
      .then(() => {
        if (pending !== update) return;
        fetched = true;
        if (state().kind === "available") {
          setState({
            kind: "downloaded",
            version: update.version,
            notes: update.body ?? null,
          });
        }
      });
    quiet = run;
    // A failed quiet download leaves the update "available"; installing
    // starts a fresh download and shows that one's error.
    run.catch((err: unknown) => {
      if (quiet === run) quiet = null;
      console.error("update download", err);
    });
    return run;
  }

  async function runCheck(manual: boolean): Promise<void> {
    const current = state().kind;
    if (current === "downloading" || current === "ready") return;
    const gen = ++generation;
    lastCheckAt = now();
    if (manual) setState({ kind: "checking" });
    try {
      const update = await lookup();
      if (gen !== generation) return;
      if (update) {
        if (pending?.version === update.version && quiet) {
          if (manual) {
            setState({
              kind: fetched ? "downloaded" : "available",
              version: update.version,
              notes: update.body ?? null,
            });
          }
          return;
        }
        pending = update;
        quiet = null;
        setState({
          kind: "available",
          version: update.version,
          notes: update.body ?? null,
        });
        void startFetch(update);
      } else {
        pending = null;
        quiet = null;
        setState({ kind: "none", checkedAt: now() });
      }
    } catch (err) {
      if (gen !== generation) return;
      console.error("update check", err);
      if (manual) {
        setState({ kind: "error", message: describe(err), during: "check" });
      }
    }
  }

  async function install(): Promise<void> {
    const update = pending;
    if (!update) return;
    const gen = ++generation;
    const show = () => {
      if (gen !== generation) return;
      setState({
        kind: "downloading",
        version: update.version,
        received,
        total,
      });
    };
    onProgress = show;
    try {
      if (!fetched) {
        show();
        await (quiet ?? startFetch(update));
      }
      if (gen !== generation) return;
      setState({ kind: "ready", version: update.version });
      // The app quits as the installer starts; the splash covers the gap.
      await cover().catch((err: unknown) =>
        console.error("update splash", err),
      );
      await update.install();
      pending = null;
      await restart();
    } catch (err) {
      if (gen !== generation) return;
      console.error("update install", err);
      // The installer may have taken the downloaded bytes; a retry fetches
      // them again.
      fetched = false;
      quiet = null;
      setState({ kind: "error", message: describe(err), during: "install" });
    } finally {
      if (onProgress === show) onProgress = null;
    }
  }

  function dismiss(): void {
    const update = pending;
    if (state().kind !== "error" || !update) return;
    setState({
      kind: "available",
      version: update.version,
      notes: update.body ?? null,
    });
  }

  function schedule(): () => void {
    // The startup window already looked, unless the app started without it.
    lastCheckAt = now();
    void checkedAtLaunch().then(
      (ran) => {
        if (!ran) void runCheck(false);
      },
      () => void runCheck(false),
    );
    const every = setInterval(() => void runCheck(false), CHECK_EVERY_MS);
    const stopFocus = onFocus(() => {
      if (now() - lastCheckAt >= FOCUS_RECHECK_MS) void runCheck(false);
    });
    return () => {
      clearInterval(every);
      stopFocus();
    };
  }

  return {
    state,
    check: (manual) => runCheck(manual),
    install,
    dismiss,
    schedule,
  };
}

/** The plugin's check, as the store and the startup window use it. */
export async function findUpdate(
  timeoutMs?: number,
): Promise<PendingUpdate | null> {
  const update: Update | null = await check(
    timeoutMs === undefined ? undefined : { timeout: timeoutMs },
  );
  if (!update) return null;
  return {
    version: update.version,
    body: update.body,
    download: (onEvent) => update.download(onEvent),
    install: () => update.install(),
  };
}

/** Starts the window that covers the install once the app quits. */
export function startUpdateSplash(): Promise<void> {
  return invoke("update_splash_start", { palette: palette() });
}

function windowFocus(cb: () => void): () => void {
  window.addEventListener("focus", cb);
  return () => window.removeEventListener("focus", cb);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultStore = createUpdateStore();
export const updateState = defaultStore.state;
export const checkForUpdates = defaultStore.check;
export const installUpdate = defaultStore.install;
export const dismissUpdate = defaultStore.dismiss;
export const scheduleUpdateChecks = defaultStore.schedule;
