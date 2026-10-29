// Mounted with the chat for the whole session: keeps the stream log
// following the stores, loads the stream manager the first time the
// curtain opens, tracks the user's own stream and ad schedule only while
// it is down, and keeps the curtain on screen until it has rolled up.

import {
  Component,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import {
  currentUserId,
  scopeGroupReady,
  streamManagerNeedsReconnect,
} from "../../stores/authStore";
import { currentAdBreak, trackAdSchedule } from "../../stores/adStore";
import {
  clearStreamManager,
  currentPoll,
  currentPrediction,
  loadStreamManager,
} from "../../stores/streamManagerStore";
import {
  ownChannelMonetized,
  setStreamManagerOpen,
  streamManagerOpen,
} from "../../stores/streamManagerPanelStore";
import { loadUserInfo } from "../../stores/userInfoStore";
import { followStreamLog } from "../../stores/streamLogStore";
import { createStreamStore } from "../../stores/streamStore";
import Curtain from "./Curtain";

const StreamManager: Component = () => {
  const [shown, setShown] = createSignal(false);
  const [opened, setOpened] = createSignal(false);
  createEffect(() => {
    if (streamManagerOpen()) {
      setShown(true);
      setOpened(true);
    }
  });

  const stream = createStreamStore();
  stream.track(() =>
    streamManagerOpen() ? (currentUserId() ?? undefined) : undefined,
  );

  followStreamLog({
    adBreak: currentAdBreak,
    poll: currentPoll,
    prediction: currentPrediction,
  });

  // Loads on first open, again after a reconnect adds the permission, and
  // drops the old account's data on a switch.
  createEffect(
    on(
      () =>
        opened() && !streamManagerNeedsReconnect() ? currentUserId() : null,
      (owner) => {
        if (owner === null) return;
        clearStreamManager();
        void loadStreamManager();
        void loadUserInfo([owner]);
      },
    ),
  );
  createEffect(
    on(
      () =>
        streamManagerOpen() &&
        scopeGroupReady("ads") &&
        ownChannelMonetized() === true,
      (track) => {
        if (track) onCleanup(trackAdSchedule());
      },
    ),
  );

  // An Escape meant for a dialog, or already handled, leaves it down.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !streamManagerOpen())
      return;
    if (e.target instanceof Element && e.target.closest("[role=dialog]"))
      return;
    setStreamManagerOpen(false);
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // A click anywhere else rolls it up. Pickers open in the top layer outside
  // the curtain's box, and the header button toggles it by itself.
  const onDown = (e: PointerEvent) => {
    if (!streamManagerOpen() || !(e.target instanceof Element)) return;
    if (
      e.target.closest(
        "[data-stream-manager], [data-stream-manager-toggle], select, option",
      )
    )
      return;
    setStreamManagerOpen(false);
  };
  document.addEventListener("pointerdown", onDown);
  onCleanup(() => document.removeEventListener("pointerdown", onDown));

  return (
    <Show when={shown()}>
      <Curtain
        info={stream.info()}
        closing={!streamManagerOpen()}
        onClosed={() => setShown(false)}
      />
    </Show>
  );
};

export default StreamManager;
