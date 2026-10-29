// Picks the root for this window by its label: user cards and pop-out
// players get their own small trees, every other window the app. Loaded
// lazily so those windows never mount the main window's tree or start its
// feed.

import type { Component } from "solid-js";
import { render } from "solid-js/web";
import { isCardWindow } from "./lib/userCardWindow";
import { isVideoWindow } from "./lib/videoWindow";

export async function boot(label: string, root: HTMLElement): Promise<void> {
  const { default: Root }: { default: Component } = isCardWindow(label)
    ? await import("./UserCardWindow")
    : isVideoWindow(label)
      ? await import("./VideoWindow")
      : await import("./App");
  render(() => <Root />, root);
}
