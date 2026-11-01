// Top chrome: logo, mentions, fullscreen, the account avatar, the settings
// gear and the window buttons. Owns the dialogs those buttons open and the
// global shortcuts that reach them. The dialogs render beside the header,
// not in it, so the header can slide away in fullscreen.

import {
  Component,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  currentSidecarStatus,
  type SidecarState,
  type SidecarStatus,
} from "../lib/sidecarStatus";
import { reconnectScopes } from "../stores/roleStore";
import {
  applyWindowSettings,
  reapplyZoom,
  settings,
  textBigger,
  textReset,
  textSmaller,
} from "../stores/settingsStore";
import ChannelPicker from "./ChannelPicker";
import { settingsOpen, setSettingsOpen } from "../stores/settingsPanelStore";
import { closePicker, openPicker, pickerOpen } from "../stores/pickerStore";
import { searchOpen, setSearchOpen } from "../stores/searchStore";
import {
  mentionsOpen,
  setMentionsOpen,
  unreadMentions,
} from "../stores/mentionsStore";
import { accountOpen } from "../stores/accountPanelStore";
import { tourStep } from "../stores/tourStore";
import {
  chromeShown,
  customChrome,
  fullscreen,
  hideChromeSoon,
  noteFullscreen,
  holdChrome,
  notePointerOnChrome,
  peekChrome,
  showChrome,
} from "../stores/windowStore";
import WindowControls from "./WindowControls";
import Mentions from "./Mentions";
import AccountAvatar from "./AccountAvatar";
import UpdateButton from "./UpdateButton";
import ChatSearch from "./ChatSearch";
import { installUpdate, updateState } from "../stores/updateStore";
import { updatedTo, whatsNewUnseen } from "../stores/whatsNewStore";
import Settings from "./Settings";
import { settingsAttention } from "../lib/settingsAttention";
import { logo } from "../stores/themeStore";
import {
  streamManagerOpen,
  toggleStreamManager,
} from "../stores/streamManagerPanelStore";

export interface HeaderProps {
  login: string;
  onSignOut: () => void;
}

const CLICK_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

// A short motion on the clicked button's icon. Script animations ignore the
// CSS reduced-motion rule, so the preference is checked here.
function animateIcon(
  e: MouseEvent,
  keyframes: Keyframe[],
  duration: number,
): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const svg = (e.currentTarget as HTMLElement).querySelector("svg");
  svg?.animate?.(keyframes, { duration, easing: CLICK_EASE });
}

const Header: Component<HeaderProps> = (props) => {
  const [state, setState] = createSignal<SidecarState | null>(null);
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
      .then(noteFullscreen)
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
          closePicker();
          setSettingsOpen(false);
          setSearchOpen(true);
          break;
        case "k":
        case "K":
          e.preventDefault();
          setSettingsOpen(false);
          openPicker();
          break;
        case ",":
          e.preventDefault();
          closePicker();
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

  // In fullscreen the bar stays down while anything opened from it is open.
  createEffect(() =>
    holdChrome(
      settingsOpen() ||
        streamManagerOpen() ||
        searchOpen() ||
        mentionsOpen() ||
        accountOpen(),
    ),
  );

  onCleanup(() => {
    disposed = true;
    unlisten?.();
    unlistenResize?.();
    unlistenScale?.();
    unlisten = undefined;
  });

  const attentions = createMemo(() =>
    settingsAttention({
      missingScopes: reconnectScopes(),
      update: updateState(),
      sidecar: state(),
      unseenUpdate: whatsNewUnseen() ? updatedTo() : null,
      setupPending: !settings().setupDone && tourStep() === null,
    }),
  );
  // The avatar's dot speaks for the most urgent one, and Settings from its
  // panel lands on the section that deals with it.
  const attention = () => attentions()[0] ?? null;

  return (
    <>
      <header
        class="header"
        classList={{
          "header--chrome": customChrome(),
          "header--autohide": fullscreen(),
          "header--shown": fullscreen() && chromeShown() && !settingsOpen(),
        }}
        data-tauri-drag-region
        onPointerEnter={() => notePointerOnChrome(true)}
        onPointerLeave={() => notePointerOnChrome(false)}
        onFocusIn={() => fullscreen() && showChrome()}
        onFocusOut={(e) => {
          const next = e.relatedTarget as Node | null;
          if (fullscreen() && !e.currentTarget.contains(next)) hideChromeSoon();
        }}
      >
        <img
          class="header__logo"
          src={logo()}
          alt=""
          draggable={false}
          data-tauri-drag-region
        />

        <span class="header__spacer" data-tauri-drag-region />

        <Show when={settings().streamManager}>
          <button
            type="button"
            class="icon-btn"
            classList={{ "icon-btn--active": streamManagerOpen() }}
            aria-label="Stream manager"
            data-stream-manager-toggle
            data-tour="stream-manager"
            aria-expanded={streamManagerOpen()}
            title="Stream manager"
            onClick={(e) => {
              animateIcon(
                e,
                [
                  { transform: "scale(1)" },
                  { transform: "scale(1.18)", offset: 0.4 },
                  { transform: "scale(1)" },
                ],
                360,
              );
              toggleStreamManager();
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="1.6" fill="currentColor" />
              <path
                d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 12.9a7 7 0 0 1 0-9.8M12.9 3.1a7 7 0 0 1 0 9.8"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </Show>

        <button
          type="button"
          class="icon-btn"
          aria-haspopup="dialog"
          aria-expanded={searchOpen()}
          title="Search chat (Ctrl+F)"
          onClick={(e) => {
            animateIcon(
              e,
              [
                { transform: "rotate(0) scale(1)" },
                { transform: "rotate(-18deg) scale(1.15)", offset: 0.4 },
                { transform: "rotate(0) scale(1)" },
              ],
              380,
            );
            closePicker();
            setSettingsOpen(false);
            setSearchOpen(true);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="7"
              cy="7"
              r="4.5"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <path
              d="m10.5 10.5 3 3"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          class="icon-btn"
          aria-haspopup="dialog"
          title={
            unreadMentions() > 0
              ? `Mentions: ${unreadMentions()} new`
              : "Mentions"
          }
          onClick={(e) => {
            animateIcon(
              e,
              [
                { transform: "scale(1) rotate(0)" },
                { transform: "scale(0.75) rotate(-25deg)", offset: 0.3 },
                { transform: "scale(1.15) rotate(10deg)", offset: 0.65 },
                { transform: "scale(1) rotate(0)" },
              ],
              420,
            );
            setMentionsOpen(true);
          }}
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
            {/* Each corner turns in place: outward to enter, inward to exit. */}
            <g
              class="fs-icon"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path class="fs-icon__corner" d="M2 6V2h4" />
              <path class="fs-icon__corner" d="M10 2h4v4" />
              <path class="fs-icon__corner" d="M14 10v4h-4" />
              <path class="fs-icon__corner" d="M6 14H2v-4" />
            </g>
          </svg>
        </button>

        <AccountAvatar
          login={props.login}
          attention={attention()}
          onSignOut={props.onSignOut}
        />

        <UpdateButton
          state={updateState()}
          onInstall={() => void installUpdate()}
        />

        <WindowControls />
      </header>
      <Show when={fullscreen() && !chromeShown()}>
        <div
          class="chrome-hotzone"
          aria-hidden="true"
          onPointerEnter={peekChrome}
        />
      </Show>
      <ChannelPicker open={pickerOpen()} onClose={closePicker} />
      <ChatSearch open={searchOpen()} onClose={() => setSearchOpen(false)} />
      <Mentions />
      <Settings
        open={settingsOpen()}
        login={props.login}
        attentions={attentions()}
        onClose={() => setSettingsOpen(false)}
        onSignOut={() => {
          setSettingsOpen(false);
          props.onSignOut();
        }}
      />
    </>
  );
};

export default Header;
