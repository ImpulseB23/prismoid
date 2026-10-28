// Starts the Windows uninstaller. Mirrors src-tauri/src/uninstall.rs.

import { invoke } from "@tauri-apps/api/core";

export interface UninstallError {
  /**
   * not_installed: no uninstaller next to the app (dev build, other install
   * method, not Windows); the user has to go through Windows Settings > Apps.
   * launch_failed: the uninstaller is there but would not start.
   */
  kind: "not_installed" | "launch_failed";
  message: string;
}

export function isUninstallError(e: unknown): e is UninstallError {
  if (typeof e !== "object" || e === null) return false;
  const { kind, message } = e as { kind?: unknown; message?: unknown };
  return (
    (kind === "not_installed" || kind === "launch_failed") &&
    typeof message === "string"
  );
}

/** Opens the uninstaller and quits the app so it can remove the files. */
export function uninstallApp(): Promise<void> {
  return invoke("uninstall_app");
}
