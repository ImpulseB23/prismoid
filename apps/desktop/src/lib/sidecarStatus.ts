// Sidecar state as the host reports it, and the indicator it maps to.

import { invoke } from "@tauri-apps/api/core";

export type SidecarState =
  | "spawning"
  | "waiting_for_auth"
  | "backoff"
  | "running"
  | "unhealthy"
  | "terminated";

export interface SidecarStatus {
  state: SidecarState;
  attempt: number;
  backoff_ms?: number;
}

/** The host's latest status, for a window that mounted after it was sent. */
export function currentSidecarStatus(): Promise<SidecarStatus | null> {
  return invoke("current_sidecar_status");
}
