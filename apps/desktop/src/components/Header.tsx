// Top chrome: logo, the channel switcher, the sidecar connection dot, an
// always-on-top pin, the settings gear and the window buttons. Owns the two
// dialogs those buttons open and the global shortcuts that reach them.

import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  currentSidecarStatus,
  type SidecarState,
  type SidecarStatus,
} from "../lib/sidecarStatus";
import { missingScopes } from "../stores/authStore";
import {
  applyWindowSettings,
  reapplyZoom,
  settings,
  textBigger,
  textReset,
  textSmaller,
  updateSettings,
} from "../stores/settingsStore";
import ChannelPicker from "./ChannelPicker";
import ChatModes from "./ChatModes";
import { modesOpen, setModesOpen } from "../stores/modesPanelStore";
import { canModerate } from "../stores/roleStore";
import { pickerOpen, setPickerOpen } from "../stores/pickerStore";
import { searchOpen, setSearchOpen } from "../stores/searchStore";
import { setMentionsOpen, unreadMentions } from "../stores/mentionsStore";
import Mentions from "./Mentions";
import ChatSearch from "./ChatSearch";
import { updateState } from "../stores/updateStore";
import {
  markWhatsNewSeen,
  updatedTo,
  whatsNewUnseen,
} from "../stores/whatsNewStore";
import Settings from "./Settings";
import { logo } from "../stores/themeStore";
import { customChrome } from "../stores/windowStore";
import WindowControls from "./WindowControls";

export interface HeaderProps {
  login: string;
  onSignOut: () => void;
}

/** Outline of an eight-tooth gear centred in a 16 px box. */
const GEAR_PATH = (() => {
  const teeth = 8;
  const outer = 7;
  const inner = 5.4;
  const steps = teeth * 4;
  const parts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const r = i % 4 < 2 ? outer : inner;
    const angle = ((i - 0.5) / steps) * Math.PI * 2;
    const x = (8 + r * Math.cos(angle)).toFixed(2);
    const y = (8 + r * Math.sin(angle)).toFixed(2);
    parts.push(`${i === 0 ? "M" : "L"}${x} ${y}`);
  }
  return `${parts.join(" ")} Z`;
})();

const Header: Component<HeaderProps> = (props) => {
  const [state, setState] = createSignal<SidecarState | null>(null);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  let unlisten: UnlistenFn | undefined;
  let unlistenResize: UnlistenFn | undefined;
  let unlistenScale: UnlistenFn | undefined;
  // listen() is async, so a fast unmount can race the registration: if
  // onCleanup runs first, `unlisten` is still undefined and the listener
  // would leak when the promise resolves later. Track disposal explicitly
  // so the late-arriving handle can be torn down immediately.
  let disposed = false;

  const report = (what: string) => (err: unknown) => console.error(what, err);

  // Borderless: the window covers the monitor without exclusive mode, so
  // alt-tabbing and overlays keep working. The button reflects what the
  // window reports, not what we last asked for, so state restored by the
  // window-state plugin or changed by the OS shows correctly too.
  const syncFullscreen = () =>
    getCurrentWindow()
      .isFullscreen()
      .then(setFullscreen)
      .catch(report("read fullscreen"));

  const toggleFullscreen = async () => {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
    await syncFullscreen();
  };

  onMount(() => {
    // The host only emits on transitions, so a window that mounts after the
    // sidecar connected asks for the current state; a transition that lands
    // first wins.
    currentSidecarStatus()
      .then((status) => {
        if (status && state() === null) setState(status.state);
      })
      .catch(report("failed to read sidecar status"));
    listen<SidecarStatus>("sidecar_status", (evt) => {
      setState(evt.payload.state);
    })
      .then((next) => {
        if (disposed) {
          next();
          return;
        }
        unlisten = next;
      })
      .catch(report("failed to subscribe to sidecar_status"));

    void applyWindowSettings().catch(report("failed to apply window settings"));
    void syncFullscreen();
    getCurrentWindow()
      .onResized(() => void syncFullscreen())
      .then((next) => {
        if (disposed) {
          next();
          return;
        }
        unlistenResize = next;
      })
      .catch(report("failed to subscribe to window resize"));
    // Moving to a display with another Windows scale changes the base zoom.
    getCurrentWindow()
      .onScaleChanged(
        () => void reapplyZoom().catch(report("failed to reapply zoom")),
      )
      .then((next) => {
        if (disposed) {
          next();
          return;
        }
        unlistenScale = next;
      })
      .catch(report("failed to subscribe to scale changes"));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen().catch(report("toggle fullscreen"));
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      switch (e.key) {
        case "f":
        case "F":
          e.preventDefault();
          setPickerOpen(false);
          setSettingsOpen(false);
          setSearchOpen(true);
          break;
        case "k":
        case "K":
          e.preventDefault();
          setSettingsOpen(false);
          setPickerOpen(true);
          break;
        case ",":
          e.preventDefault();
          setPickerOpen(false);
          setSettingsOpen((o) => !o);
          break;
        case "=":
        case "+":
          e.preventDefault();
          void textBigger().catch(report("text bigger"));
          break;
        case "-":
        case "_":
          e.preventDefault();
          void textSmaller().catch(report("text smaller"));
          break;
        case "0":
          e.preventDefault();
          void textReset().catch(report("text reset"));
          break;
      }
    };
    // Ctrl with + - 0 and Ctrl+wheel size the chat text, like Chatterino;
    // whole-window zoom lives in Settings. The webview's own zoom hotkeys
    // are off (zoomHotkeysEnabled defaults false) so these reach us.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      void (e.deltaY < 0 ? textBigger() : textSmaller()).catch(
        report("text size"),
      );
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    });
  });

  onCleanup(() => {
    disposed = true;
    unlisten?.();
    unlistenResize?.();
    unlistenScale?.();
    unlisten = undefined;
  });

  const pinned = () => settings().alwaysOnTop;

  // Something in Settings needs the user: a reconnect for new scopes, or a
  // chat connection that is not coming back on its own.
  const attention = (): string | null => {
    if (missingScopes().length > 0) return "Twitch needs new permissions";
    const u = updateState();
    if (u.kind === "available") return `Update to ${u.version} is ready`;
    const s = state();
    if (s === "terminated" || s === "unhealthy") return "Chat is disconnected";
    if (s === "waiting_for_auth") return "Waiting for sign-in";
    if (whatsNewUnseen()) return `Updated to ${updatedTo()}`;
    return null;
  };

  return (
    <header
      class="header"
      classList={{ "header--chrome": customChrome() }}
      data-tauri-drag-region
    >
      <img
        class="header__logo"
        src={logo()}
        alt=""
        draggable={false}
        data-tauri-drag-region
      />

      <span class="header__spacer" data-tauri-drag-region />

      <Show when={canModerate()}>
        <button
          type="button"
          class="icon-btn"
          aria-haspopup="dialog"
          aria-expanded={modesOpen()}
          data-tour="chat-modes"
          title="Chat modes"
          onClick={() => {
            setPickerOpen(false);
            setSettingsOpen(false);
            setModesOpen(true);
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 4.5h12M2 8h12M2 11.5h12"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
            <circle
              cx="5.5"
              cy="4.5"
              r="1.6"
              fill="var(--bg)"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <circle
              cx="10.5"
              cy="8"
              r="1.6"
              fill="var(--bg)"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <circle
              cx="6.5"
              cy="11.5"
              r="1.6"
              fill="var(--bg)"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </button>
      </Show>

      <button
        type="button"
        class="icon-btn"
        aria-haspopup="dialog"
        title={
          unreadMentions() > 0
            ? `Mentions: ${unreadMentions()} new`
            : "Mentions"
        }
        onClick={() => setMentionsOpen(true)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="2.6"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M10.6 8v1.2a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <Show when={unreadMentions() > 0}>
          <span class="icon-btn__badge" aria-hidden="true" />
        </Show>
      </button>

      <button
        type="button"
        class="icon-btn"
        classList={{ "icon-btn--active": fullscreen() }}
        aria-pressed={fullscreen()}
        title={fullscreen() ? "Exit fullscreen" : "Fullscreen"}
        onClick={() =>
          void toggleFullscreen().catch(report("toggle fullscreen"))
        }
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <button
        type="button"
        class="icon-btn"
        classList={{ "icon-btn--active": pinned() }}
        aria-pressed={pinned()}
        title={pinned() ? "Unpin from top" : "Keep on top of other windows"}
        onClick={() =>
          void updateSettings({ alwaysOnTop: !pinned() }).catch(
            report("failed to toggle always-on-top"),
          )
        }
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M9.5 1.5 14.5 6.5l-2 .5-3 3 .5 3.5L6 9.5l-4 4L2 11l4-4L2.5 3.5 6 4l3-3 .5-2.5Z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
            fill={pinned() ? "currentColor" : "none"}
          />
        </svg>
      </button>

      <button
        type="button"
        class="icon-btn"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen()}
        data-tour="settings"
        title={attention() ? `Settings: ${attention()}` : "Settings"}
        onClick={() => {
          markWhatsNewSeen();
          setSettingsOpen(true);
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d={GEAR_PATH}
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <circle
            cx="8"
            cy="8"
            r="2.1"
            stroke="currentColor"
            stroke-width="1.3"
          />
        </svg>
        <Show when={attention()}>
          <span class="icon-btn__badge" aria-hidden="true" />
        </Show>
      </button>

      <WindowControls />

      <ChannelPicker open={pickerOpen()} onClose={() => setPickerOpen(false)} />
      <ChatModes open={modesOpen()} onClose={() => setModesOpen(false)} />
      <ChatSearch open={searchOpen()} onClose={() => setSearchOpen(false)} />
      <Mentions />
      <Settings
        open={settingsOpen()}
        login={props.login}
        onClose={() => setSettingsOpen(false)}
        onSignOut={() => {
          setSettingsOpen(false);
          props.onSignOut();
        }}
      />
    </header>
  );
};

export default Header;
