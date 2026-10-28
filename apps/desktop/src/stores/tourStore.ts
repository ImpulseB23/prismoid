// The welcome tour: shown once after the first sign-in, replayable from
// Settings. Finishing or skipping records it in the settings store so it
// does not come back on the next launch.

import { createSignal } from "solid-js";
import { settings, updateSettings } from "./settingsStore";

export interface TourStep {
  /** `data-tour` value of the element to highlight, if any. */
  target?: string;
  title: string;
  body: string;
  /** Offers the Follow my browser and Keep on top switches. */
  toggles?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to prismoid",
    body: "Your chat is open below. Every channel gets its own tab, chat stays when you switch away or restart, and moderation happens right in the feed.",
  },
  {
    target: "add-channel",
    title: "Open any channel",
    body: "Use + or press Ctrl+K to open another channel. Tabs show how many messages you missed, and Ctrl+Tab moves between them.",
  },
  {
    target: "feed",
    title: "Moderate from the message",
    body: "In your own channel and any you moderate, right-click a message or click a name to time out, ban or delete. Timeouts and bans by other mods show up in chat too.",
  },
  {
    target: "settings",
    title: "Two things worth turning on",
    body: "Both are off until you want them, and both live in Settings.",
    toggles: true,
  },
  {
    title: "That's the tour",
    body: "You can take it again any time from Settings.",
  },
];

export interface TourStore {
  step: () => number | null;
  start: () => void;
  next: () => void;
  back: () => void;
  /** Ends the tour, finished or skipped, and remembers it. */
  finish: () => Promise<void>;
  /** Starts the tour if it has never been finished or skipped. */
  offer: () => void;
}

export function createTourStore(
  steps: number,
  done: () => boolean,
  markDone: () => Promise<void>,
): TourStore {
  const [step, setStep] = createSignal<number | null>(null);

  async function finish(): Promise<void> {
    setStep(null);
    if (!done()) await markDone();
  }

  return {
    step,
    start: () => setStep(0),
    next: () => {
      const s = step();
      if (s === null) return;
      if (s + 1 >= steps) void finish();
      else setStep(s + 1);
    },
    back: () => {
      const s = step();
      if (s !== null && s > 0) setStep(s - 1);
    },
    finish,
    offer: () => {
      if (!done() && step() === null) setStep(0);
    },
  };
}

const defaultStore = createTourStore(
  TOUR_STEPS.length,
  () => settings().tourDone,
  () => updateSettings({ tourDone: true }),
);
export const tourStep = defaultStore.step;
export const startTour = defaultStore.start;
export const nextTourStep = defaultStore.next;
export const previousTourStep = defaultStore.back;
export const finishTour = defaultStore.finish;
export const offerTour = defaultStore.offer;
