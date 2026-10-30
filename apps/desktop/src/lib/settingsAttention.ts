// Everything in Settings waiting on the user, most urgent first. The avatar
// shows the first, the Settings nav marks every section listed, and each
// section marks the row that deals with it.

import type { SettingsSection } from "../stores/settingsPanelStore";
import type { SidecarState } from "./sidecarStatus";
import type { UpdateState } from "../stores/updateStore";
import { displayVersion } from "./version";

export type AttentionRow = "reconnect" | "update" | "setup";

export interface Attention {
  text: string;
  /** Where Settings opens for it; absent when no setting fixes it. */
  section?: SettingsSection;
  row?: AttentionRow;
}

export interface AttentionInputs {
  missingScopes: string[];
  update: UpdateState;
  sidecar: SidecarState | null;
  /** The version an update just installed, while its notes are unseen. */
  unseenUpdate: string | null;
  setupPending: boolean;
}

export function settingsAttention(i: AttentionInputs): Attention[] {
  const list: Attention[] = [];
  if (i.missingScopes.length > 0)
    list.push({
      text: "Twitch needs new permissions",
      section: "account",
      row: "reconnect",
    });
  if (i.update.kind === "available")
    list.push({
      text: `Update to ${displayVersion(i.update.version)} is ready`,
      section: "updates",
      row: "update",
    });
  if (i.sidecar === "terminated" || i.sidecar === "unhealthy")
    list.push({ text: "Chat is disconnected" });
  if (i.sidecar === "waiting_for_auth")
    list.push({ text: "Waiting for sign-in", section: "account" });
  if (i.unseenUpdate)
    list.push({
      text: `Updated to ${displayVersion(i.unseenUpdate)}`,
      section: "updates",
      row: "update",
    });
  if (i.setupPending)
    list.push({ text: "Set up Prismoid", section: "help", row: "setup" });
  return list;
}
