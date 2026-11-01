// Picks the root for this window by its label: user cards, pop-out
// players and the update splash get their own small trees, every other
// window the app. Loaded
// lazily so those windows never mount the main window's tree or start its
// feed, and so the main window's stores read localStorage only after an old
// origin's copy is in.

import type { Component } from "solid-js";
import { render } from "solid-js/web";
import { isCardWindow } from "./lib/userCardWindow";
import { isVideoWindow } from "./lib/videoWindow";
import {
  exportOldStorage,
  importOldStorage,
  STORAGE_MOVE_LABEL,
} from "./lib/storageMove";

/** Matches the host's update splash window. */
export const UPDATE_SPLASH_LABEL = "update-splash";

export async function boot(label: string, root: HTMLElement): Promise<void> {
  if (label === STORAGE_MOVE_LABEL) return exportOldStorage(localStorage);
  let Root: Component;
  if (label === UPDATE_SPLASH_LABEL) {
    Root = (await import("./UpdateSplash")).default;
  } else if (isCardWindow(label)) {
    Root = (await import("./UserCardWindow")).default;
  } else if (isVideoWindow(label)) {
    Root = (await import("./VideoWindow")).default;
  } else {
    // Only the app reads the moved storage.
    await importOldStorage(localStorage).catch((err: unknown) =>
      console.error("storage move", err),
    );
    Root = (await import("./App")).default;
  }
  render(() => <Root />, root);
}
