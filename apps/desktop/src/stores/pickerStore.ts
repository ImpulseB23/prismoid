// The channel picker's open state and the live follows it lists. The header
// shortcut and the tab strip's add button both open it. The list, with its
// avatars, loads before the picker opens so nothing fills in afterwards;
// `pickerLoading` drives a spinner on the add button meanwhile.

import { createSignal } from "solid-js";
import { getFollowedLive, type FollowedLive } from "../lib/twitchChannel";
import { preloadImages } from "../lib/preload";
import { missingScopes } from "./authStore";
import { loadUserInfo, userInfo } from "./userInfoStore";

export type LiveState = "ready" | "needs_scope" | "failed";

/** A list this fresh is reused instead of asking Twitch again. */
export const LIVE_FRESH_MS = 30_000;

const [pickerOpen, setOpen] = createSignal(false);
/** The picked channel opens in a new pane instead of the focused one. */
const [pickerSplits, setSplits] = createSignal(false);
const [pickerLoading, setLoading] = createSignal(false);
const [followedLive, setFollowedLive] = createSignal<FollowedLive[]>([]);
const [liveState, setLiveState] = createSignal<LiveState>("ready");

let request: Promise<void> | null = null;
let fetchedAt = -Infinity;
let openSeq = 0;

/** Loads the live list unless a fresh one is at hand. Never rejects. */
export function prefetchLive(): Promise<void> {
  if (request) return request;
  if (Date.now() - fetchedAt < LIVE_FRESH_MS) return Promise.resolve();
  // A grant without the follows scope gets a reconnect hint instead of a
  // call that would fail.
  if (missingScopes().includes("user:read:follows")) {
    setFollowedLive([]);
    setLiveState("needs_scope");
    return Promise.resolve();
  }
  request = getFollowedLive()
    .then(async (found) => {
      const ids = found.map((c) => c.id);
      await loadUserInfo(ids);
      await preloadImages(
        ids.map((id) => userInfo(id)?.profile_image_url ?? ""),
      );
      setFollowedLive(found);
      setLiveState("ready");
      fetchedAt = Date.now();
    })
    .catch((e: unknown) => {
      setFollowedLive([]);
      setLiveState("failed");
      console.error("followed live", e);
    })
    .finally(() => {
      request = null;
    });
  return request;
}

/** Opens once the live list is ready; a failed load still opens. */
export function openPicker(opts: { split?: boolean } = {}): void {
  if (pickerOpen()) return;
  setSplits(opts.split === true);
  const seq = ++openSeq;
  setLoading(true);
  void prefetchLive().then(() => {
    if (seq !== openSeq) return;
    setLoading(false);
    setOpen(true);
  });
}

export function closePicker(): void {
  ++openSeq;
  setLoading(false);
  setOpen(false);
}

export { pickerOpen, pickerSplits, pickerLoading, followedLive, liveState };
