// A pop-out stream player: Twitch's player filling the window. The
// player's own fullscreen button only fills the page, so the window follows
// it into and out of fullscreen on the display it is on.

import { onCleanup, onMount, type Component } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PlayerFrame } from "./components/StreamVideo";
import { videoWindowLogin } from "./lib/videoWindow";

const VideoWindow: Component = () => {
  const login = videoWindowLogin(getCurrentWindow().label);

  onMount(() => {
    const follow = () => {
      void getCurrentWindow()
        .setFullscreen(document.fullscreenElement !== null)
        .catch((err: unknown) => console.error("video fullscreen", err));
    };
    document.addEventListener("fullscreenchange", follow);
    onCleanup(() => document.removeEventListener("fullscreenchange", follow));
  });

  return (
    <main class="video-window">
      <PlayerFrame login={login} name={login} />
    </main>
  );
};

export default VideoWindow;
