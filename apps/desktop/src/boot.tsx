// Picks the root for this window by its label: the stream manager gets its
// own small tree, every other window the app. Loaded lazily so a side
// window never evaluates the main window's stores.

import type { Component } from "solid-js";
import { render } from "solid-js/web";
import { isStreamManagerWindow } from "./lib/streamManagerWindow";

async function rootFor(label: string): Promise<Component> {
  if (isStreamManagerWindow(label)) {
    return (await import("./StreamManagerWindow")).default;
  }
  return (await import("./App")).default;
}

export async function boot(label: string, root: HTMLElement): Promise<void> {
  const Root = await rootFor(label);
  render(() => <Root />, root);
}
