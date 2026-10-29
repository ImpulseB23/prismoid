// Pop-out stream players. Mirrors src-tauri/src/video_window.rs: one
// window per channel, labelled by its login.

import { invoke } from "@tauri-apps/api/core";

const LABEL_PREFIX = "video-";

export function isVideoWindow(label: string): boolean {
  return label.startsWith(LABEL_PREFIX);
}

export function videoWindowLogin(label: string): string {
  return label.slice(LABEL_PREFIX.length);
}

/** Opens `login`'s player in its own window, or brings it forward. */
export function openVideoWindow(login: string, title: string): Promise<void> {
  return invoke("video_window_open", { login, title });
}
