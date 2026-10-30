// A pop-out stream player: Twitch's player under the app's own title bar,
// with the way back into chat, a pin to keep it above other windows, and
// the usual window buttons. The player's own fullscreen button only fills
// the page, so the window follows it into and out of fullscreen on the
// display it is on, and the bar steps aside meanwhile.

import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PlayerFrame } from "./components/StreamVideo";
import WindowControls from "./components/WindowControls";
import { popBackIn, videoWindowLogin } from "./lib/videoWindow";
import { trackWindowChrome } from "./stores/windowStore";

const report = (what: string) => (err: unknown) => console.error(what, err);

const VideoWindow: Component = () => {
  const win = getCurrentWindow();
  const login = videoWindowLogin(win.label);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  // The host names the window after the channel ("Caedrel's stream").
  const [title, setTitle] = createSignal(login);

  onMount(() => {
    void win.title().then(setTitle).catch(report("video title"));
    let disposed = false;
    let stopChrome: (() => void) | undefined;
    void trackWindowChrome()
      .then((stop) => {
        if (disposed) stop();
        else stopChrome = stop;
      })
      .catch(report("window chrome"));
    const follow = () => {
      const on = document.fullscreenElement !== null;
      setFullscreen(on);
      void win.setFullscreen(on).catch(report("video fullscreen"));
    };
    document.addEventListener("fullscreenchange", follow);
    onCleanup(() => {
      disposed = true;
      stopChrome?.();
      document.removeEventListener("fullscreenchange", follow);
    });
  });

  const pin = () => {
    const next = !pinned();
    void win
      .setAlwaysOnTop(next)
      .then(() => setPinned(next))
      .catch(report("pin video"));
  };

  const backToChat = () => {
    void popBackIn(login)
      .then(() => win.close())
      .catch(report("pop back in"));
  };

  return (
    <main class="video-window">
      <Show when={!fullscreen()}>
        <header class="video-window__bar" data-tauri-drag-region>
          <span class="video-window__name" data-tauri-drag-region>
            {title()}
          </span>
          <button
            type="button"
            class="video-window__back"
            title="Show the stream in its chat again"
            onClick={backToChat}
          >
            Back to chat
          </button>
          <button
            type="button"
            class="video-window__pin"
            classList={{ "video-window__pin--on": pinned() }}
            aria-pressed={pinned()}
            aria-label={pinned() ? "Stop keeping on top" : "Keep on top"}
            title={pinned() ? "Stop keeping on top" : "Keep on top"}
            onClick={pin}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M4.5 1h3l-.5 3 2 2H3l2-2zM6 6v5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <WindowControls />
        </header>
      </Show>
      <div class="video-window__player">
        <PlayerFrame login={login} name={login} />
      </div>
    </main>
  );
};

export default VideoWindow;
