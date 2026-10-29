// Picks the root for this window by its label: user cards get their own
// small tree, every other window the app. Loaded lazily so a card window
// never evaluates the main window's stores.

import type { Component } from "solid-js";
import { render } from "solid-js/web";
import { isCardWindow } from "./lib/userCardWindow";

export async function boot(label: string, root: HTMLElement): Promise<void> {
  const { default: Root }: { default: Component } = isCardWindow(label)
    ? await import("./UserCardWindow")
    : await import("./App");
  render(() => <Root />, root);
}
