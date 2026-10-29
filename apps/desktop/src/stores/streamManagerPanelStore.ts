// Whether the stream manager curtain is down and which tab it shows. The
// header button toggles it; Escape rolls it back up.

import { createSignal } from "solid-js";

export type StreamManagerTab = "live" | "ads" | "polls";

const [streamManagerOpen, setStreamManagerOpen] = createSignal(false);
const [streamManagerTab, setStreamManagerTab] =
  createSignal<StreamManagerTab>("live");

export function toggleStreamManager(): void {
  setStreamManagerOpen((open) => !open);
}

export {
  streamManagerOpen,
  setStreamManagerOpen,
  streamManagerTab,
  setStreamManagerTab,
};
