// Pop-out stream players. Mirrors src-tauri/src/video_window.rs: one
// window per channel, labelled by its login. The main window keeps which
// channels are out, so the same stream never plays twice, and takes a
// stream back into its pane's corner when the window asks.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";

const LABEL_PREFIX = "video-";
const CLOSED_EVENT = "video_window_closed";
const POP_IN_EVENT = "video_pop_in";

export function isVideoWindow(label: string): boolean {
  return label.startsWith(LABEL_PREFIX);
}

export function videoWindowLogin(label: string): string {
  return label.slice(LABEL_PREFIX.length);
}

const [poppedOut, setPoppedOut] = createSignal<ReadonlySet<string>>(new Set());

export function isPoppedOut(login: string): boolean {
  return poppedOut().has(login);
}

/** Opens `login`'s player in its own window, or brings it forward. */
export async function openVideoWindow(
  login: string,
  title: string,
): Promise<void> {
  await invoke("video_window_open", { login, title });
  setPoppedOut((s) => new Set(s).add(login));
}

/** Closes every pop-out, for when stream video is switched off. */
export function closeVideoWindows(): Promise<void> {
  return invoke("video_windows_close");
}

/** Main window: follows pop-outs closing and asking to come back in. */
export async function followVideoWindows(
  popIn: (login: string) => void,
): Promise<() => void> {
  const stops = await Promise.all([
    listen<string>(CLOSED_EVENT, (e) =>
      setPoppedOut((s) => {
        const next = new Set(s);
        next.delete(e.payload);
        return next;
      }),
    ),
    listen<string>(POP_IN_EVENT, (e) => popIn(e.payload)),
  ]);
  return () => {
    for (const stop of stops) stop();
  };
}

/** Pop-out window: hands its stream back to the main window. */
export function popBackIn(login: string): Promise<void> {
  return emitTo("main", POP_IN_EVENT, login);
}
