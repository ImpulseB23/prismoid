// Whether the stream manager curtain is down and which tab it shows. The
// header button toggles it; Escape rolls it back up.

import { createSignal } from "solid-js";
import { currentUserId } from "./authStore";
import { isMonetized, userInfo, userInfoRevision } from "./userInfoStore";

export type StreamManagerTab = "live" | "ads" | "polls";

/** Whether the signed-in channel is an Affiliate or Partner; undefined until known. */
export function ownChannelMonetized(): boolean | undefined {
  userInfoRevision();
  const id = currentUserId();
  return id === null ? undefined : isMonetized(userInfo(id));
}

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
