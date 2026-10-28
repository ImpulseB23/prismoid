// The stream manager window. Mirrors src-tauri/src/stream_manager_window.rs.

import { invoke } from "@tauri-apps/api/core";

const LABEL = "stream-manager";

export function isStreamManagerWindow(label: string): boolean {
  return label === LABEL;
}

/** Opens the stream manager, or brings it forward when it is open. */
export function openStreamManager(): Promise<void> {
  return invoke("stream_manager_open");
}

/** Shows the window once its first frame is ready. */
export function streamManagerReady(): Promise<void> {
  return invoke("stream_manager_ready");
}
