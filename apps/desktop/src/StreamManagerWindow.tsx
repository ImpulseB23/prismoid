// Root of the stream manager window: everything a streamer runs on their
// own channel, in a window they can keep on a second monitor. It is its own
// page, so it reads the account and the stream itself instead of borrowing
// the main window's stores, and follows sign-ins made over there.

import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createRenderEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { getAuthStatus, onAuthChanged } from "./lib/twitchAuth";
import { streamManagerReady } from "./lib/streamManagerWindow";
import { installContextMenus } from "./lib/appContextMenu";
import { authStatus, currentUserId, setAuthStatus } from "./stores/authStore";
import { logo, palette } from "./stores/themeStore";
import { trackWindowChrome } from "./stores/windowStore";
import WindowControls from "./components/WindowControls";
import ContextMenu from "./components/ContextMenu";
import LiveStatus from "./components/streamManager/LiveStatus";
import StreamSetup from "./components/streamManager/StreamSetup";

const report = (what: string) => (err: unknown) => console.error(what, err);

const SECTIONS = [{ id: "live", label: "Live" }] as const;
type Section = (typeof SECTIONS)[number]["id"];

const StreamManagerWindow: Component = () => {
  const [section, setSection] = createSignal<Section>("live");

  createRenderEffect(() => {
    document.documentElement.dataset.theme = palette();
  });

  onMount(() => onCleanup(installContextMenus()));

  let stopChrome: (() => void) | undefined;
  let stopAuth: (() => void) | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    stopChrome?.();
    stopAuth?.();
  });
  onMount(() => {
    trackWindowChrome()
      .then((stop) => (disposed ? stop() : (stopChrome = stop)))
      .catch(report("window chrome"));
    onAuthChanged(setAuthStatus)
      .then((stop) => (disposed ? stop() : (stopAuth = stop)))
      .catch(report("auth changes"));
    getAuthStatus()
      .then(setAuthStatus)
      .catch((err: unknown) => {
        report("auth status")(err);
        setAuthStatus({ state: "logged_out" });
      })
      .finally(() => {
        if (!disposed) {
          void streamManagerReady().catch(report("show stream manager"));
        }
      });
  });

  return (
    <div class="sm">
      <header class="sm__bar" data-tauri-drag-region>
        <img class="sm__logo" src={logo()} alt="" data-tauri-drag-region />
        <span class="sm__name" data-tauri-drag-region>
          Stream manager
        </span>
        <Show when={currentUserId()}>
          {(id) => <LiveStatus userId={id()} />}
        </Show>
        <span class="header__spacer" data-tauri-drag-region />
        <WindowControls />
      </header>

      <Switch>
        <Match when={authStatus() === null}>
          <div class="sm__empty" />
        </Match>
        <Match when={currentUserId() === null}>
          <div class="sm__empty">
            Sign in to Twitch in the main Prismoid window to manage your stream.
          </div>
        </Match>
        <Match when={currentUserId()}>
          <nav class="sm__nav" aria-label="Stream manager sections">
            <For each={SECTIONS}>
              {(s) => (
                <button
                  type="button"
                  class="settings-page__tab"
                  classList={{ "settings-page__tab--on": section() === s.id }}
                  aria-current={section() === s.id ? "page" : undefined}
                  onClick={() => setSection(s.id)}
                >
                  {s.label}
                </button>
              )}
            </For>
          </nav>
          <main class="sm__content">
            <Show when={section() === "live"}>
              <h2 class="sm__title">Live</h2>
              <StreamSetup />
            </Show>
          </main>
        </Match>
      </Switch>
      <ContextMenu />
    </div>
  );
};

export default StreamManagerWindow;
