// App updates through the Tauri updater: a check on launch and every few
// hours, a manual check from Settings, and an install that restarts the
// app. The plugin calls are injected so the store runs without a runtime.

import { createSignal } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Launch delay before the first check, so startup stays quick. */
export const FIRST_CHECK_MS = 15_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none"; checkedAt: number }
  | { kind: "available"; version: string; notes: string | null }
  | {
      kind: "downloading";
      version: string;
      received: number;
      total: number | null;
    }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

/** The slice of the plugin's update object the store needs. */
export interface PendingUpdate {
  version: string;
  body?: string;
  downloadAndInstall: (
    onEvent?: (event: DownloadEvent) => void,
  ) => Promise<void>;
}

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface UpdateStore {
  state: () => UpdateState;
  /** Looks for a newer version. Errors are shown only for a manual check. */
  check: (manual: boolean) => Promise<void>;
  /** Downloads and installs the available update, then restarts. */
  install: () => Promise<void>;
  /** Starts the launch and interval checks; returns a stop function. */
  schedule: () => () => void;
}

export function createUpdateStore(
  lookup: () => Promise<PendingUpdate | null> = checkViaPlugin,
  restart: () => Promise<void> = relaunch,
): UpdateStore {
  const [state, setState] = createSignal<UpdateState>({ kind: "idle" });
  let pending: PendingUpdate | null = null;
  let generation = 0;

  async function runCheck(manual: boolean): Promise<void> {
    const current = state().kind;
    if (current === "downloading" || current === "ready") return;
    const gen = ++generation;
    if (manual) setState({ kind: "checking" });
    try {
      const update = await lookup();
      if (gen !== generation) return;
      if (update) {
        pending = update;
        setState({
          kind: "available",
          version: update.version,
          notes: update.body ?? null,
        });
      } else {
        pending = null;
        setState({ kind: "none", checkedAt: Date.now() });
      }
    } catch (err) {
      if (gen !== generation) return;
      console.error("update check", err);
      if (manual) setState({ kind: "error", message: describe(err) });
    }
  }

  async function install(): Promise<void> {
    const update = pending;
    if (!update) return;
    const gen = ++generation;
    let received = 0;
    let total: number | null = null;
    setState({ kind: "downloading", version: update.version, received, total });
    try {
      await update.downloadAndInstall((event) => {
        if (gen !== generation) return;
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }
        setState({
          kind: "downloading",
          version: update.version,
          received,
          total,
        });
      });
      if (gen !== generation) return;
      pending = null;
      setState({ kind: "ready", version: update.version });
      await restart();
    } catch (err) {
      if (gen !== generation) return;
      console.error("update install", err);
      setState({ kind: "error", message: describe(err) });
    }
  }

  function schedule(): () => void {
    const first = setTimeout(() => void runCheck(false), FIRST_CHECK_MS);
    const every = setInterval(() => void runCheck(false), CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }

  return { state, check: runCheck, install, schedule };
}

async function checkViaPlugin(): Promise<PendingUpdate | null> {
  const update: Update | null = await check();
  if (!update) return null;
  return {
    version: update.version,
    body: update.body,
    downloadAndInstall: (onEvent) => update.downloadAndInstall(onEvent),
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const defaultStore = createUpdateStore();
export const updateState = defaultStore.state;
export const checkForUpdates = defaultStore.check;
export const installUpdate = defaultStore.install;
export const scheduleUpdateChecks = defaultStore.schedule;
