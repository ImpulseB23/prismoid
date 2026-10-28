// Settings and data resets. Mirrors src-tauri/src/reset.rs; the host only
// covers what it keeps (autostart, window geometry, sign-in, chat history),
// localStorage is the caller's to clear.

import { invoke } from "@tauri-apps/api/core";

export interface ResetError {
  kind: "sign_out" | "files" | "autostart" | "window";
  message: string;
}

const KINDS: readonly unknown[] = ["sign_out", "files", "autostart", "window"];

export function isResetError(e: unknown): e is ResetError {
  if (typeof e !== "object" || e === null) return false;
  const { kind, message } = e as { kind?: unknown; message?: unknown };
  return KINDS.includes(kind) && typeof message === "string";
}

/** Turns off start with Windows and puts the window back to its default size. */
export function resetSettings(): Promise<void> {
  return invoke("reset_settings");
}

/**
 * Everything resetSettings does, plus signing out of every platform and
 * deleting chat history and other app data. Clear localStorage and relaunch
 * afterwards.
 */
export function resetAllData(): Promise<void> {
  return invoke("reset_all_data");
}
