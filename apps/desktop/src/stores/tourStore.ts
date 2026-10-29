// The setup tour: shown once after the first sign-in, replayable from
// Settings. It points out the parts of the window that matter, then opens
// Settings and walks through each section so people choose how Prismoid
// works instead of living with defaults they never saw. Finishing or
// skipping records it so it does not come back on the next launch.

import { createSignal } from "solid-js";
import { settings, updateSettings } from "./settingsStore";
import {
  openSettings,
  setSettingsOpen,
  type SettingsSection,
} from "./settingsPanelStore";
import { LAST_VERSION_KEY } from "./whatsNewStore";

export interface TourStep {
  /** `data-tour` value of the element to ring, if any. */
  target?: string;
  /** Opens Settings on this section and rings it; its controls stay usable. */
  section?: SettingsSection;
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Let's set Prismoid up",
    body: "A quick look around, then a minute in Settings so everything works the way you want. You can change any of it later.",
  },
  {
    target: "add-channel",
    title: "Open any channel",
    body: "Use + or Ctrl+K to open another channel. Tabs show what you missed, and Ctrl+Tab moves between them.",
  },
  {
    target: "feed",
    title: "Moderate from the message",
    body: "Right-click a message or click a name to time out, ban or delete, in your channel and any you moderate.",
  },
  {
    target: "chat-modes",
    title: "Your chat manager",
    body: "Chat modes, the AutoMod queue and the mod log, all in the tab on the right edge of the chat.",
  },
  {
    section: "appearance",
    title: "Make it comfortable",
    body: "Pick a theme and the text and window size that read well from where you sit.",
  },
  {
    section: "chat",
    title: "Choose what stands out",
    body: "Highlight words or people, ping when you're mentioned, mark first-time chatters, show 7TV paints.",
  },
  {
    section: "moderation",
    title: "Your moderation defaults",
    body: "The slow mode, followers-only and timeout lengths your buttons use.",
  },
  {
    section: "window",
    title: "How the window behaves",
    body: "Keep it above your game, follow the channel in your browser, live in the tray, start with Windows.",
  },
  {
    title: "You're set",
    body: "Everything here is in Settings, and you can run this setup again from Help.",
  },
];

export interface TourStore {
  step: () => number | null;
  start: () => void;
  next: () => void;
  back: () => void;
  /** Ends the tour, finished or skipped, and remembers it. */
  finish: () => Promise<void>;
  /** Starts the tour on a fresh install that has not been set up. Someone
   * who updated from an older version gets a Settings badge instead of
   * being interrupted. */
  offer: () => void;
}

export function createTourStore(
  steps: TourStep[],
  done: () => boolean,
  markDone: () => Promise<void>,
  showSettings: (section: SettingsSection | null) => void,
  freshInstall: boolean,
): TourStore {
  const [step, setStep] = createSignal<number | null>(null);

  const go = (i: number | null) => {
    setStep(i);
    showSettings((i !== null && steps[i]?.section) || null);
  };

  async function finish(): Promise<void> {
    go(null);
    if (!done()) await markDone();
  }

  return {
    step,
    start: () => go(0),
    next: () => {
      const s = step();
      if (s === null) return;
      if (s + 1 >= steps.length) void finish();
      else go(s + 1);
    },
    back: () => {
      const s = step();
      if (s !== null && s > 0) go(s - 1);
    },
    finish,
    offer: () => {
      if (freshInstall && !done() && step() === null) go(0);
    },
  };
}

const defaultStore = createTourStore(
  TOUR_STEPS,
  () => settings().setupDone,
  () => updateSettings({ setupDone: true }),
  (section) => (section ? openSettings(section) : setSettingsOpen(false)),
  isFreshInstall(),
);
export const tourStep = defaultStore.step;
export const startTour = defaultStore.start;
export const nextTourStep = defaultStore.next;
export const previousTourStep = defaultStore.back;
export const finishTour = defaultStore.finish;
export const offerTour = defaultStore.offer;

// Read once at startup, before this launch records its version: no record
// means Prismoid has never run here.
function isFreshInstall(): boolean {
  try {
    return localStorage.getItem(LAST_VERSION_KEY) === null;
  } catch {
    return false;
  }
}
