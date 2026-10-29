// Whether Settings is open and which section it shows. The header opens it,
// the sidebar switches sections, and the setup tour drives both to walk
// through each section in turn.

import { createSignal } from "solid-js";

export const SETTINGS_SECTIONS = [
  "account",
  "features",
  "appearance",
  "chat",
  "highlights",
  "moderation",
  "window",
  "updates",
  "help",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const [settingsOpen, setSettingsOpen] = createSignal(false);
const [settingsSection, setSettingsSection] =
  createSignal<SettingsSection>("appearance");

/** Opens Settings, on a given section if one is named. */
export function openSettings(section?: SettingsSection): void {
  if (section) setSettingsSection(section);
  setSettingsOpen(true);
}

export { settingsOpen, setSettingsOpen, settingsSection, setSettingsSection };
