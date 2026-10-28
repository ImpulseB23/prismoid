// Settings dialog: accounts, appearance, chat, window. Every control
// writes straight through the settings store so there is no save step.

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  cancelLogin,
  completeLogin,
  openTwitchUrl,
  startLogin,
  type LoginView,
} from "../lib/twitchAuth";
import { missingScopes, setAuthStatus } from "../stores/authStore";
import {
  HIGHLIGHT_BADGES,
  THEMES,
  parseDurations,
  parseList,
  settings,
  updateSettings,
  textBigger,
  textReset,
  textSmaller,
  zoomIn,
  zoomOut,
  zoomReset,
  type HighlightBadge,
  type Theme,
} from "../stores/settingsStore";
import { DEFAULT_TEXT_SIZE } from "../lib/messageLayout";
import { formatSeconds } from "../lib/slashCommands";
import { openLogDir } from "../lib/log";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  checkForUpdates,
  installUpdate,
  updateState,
} from "../stores/updateStore";
import { authErrorMessage, isAuthError } from "./SignIn";
import { showPatchNotes } from "../stores/whatsNewStore";
import { notesFor } from "../releaseNotes";
import { startTour } from "../stores/tourStore";

export interface SettingsProps {
  open: boolean;
  login: string;
  onClose: () => void;
  onSignOut: () => void;
}

const BADGE_LABELS: Record<HighlightBadge, string> = {
  broadcaster: "Streamer",
  moderator: "Mods",
  vip: "VIPs",
  subscriber: "Subs",
};

const THEME_LABELS: Record<Theme, string> = {
  system: "Match Windows",
  dark: "Dark",
  midnight: "Midnight",
  light: "Light",
  prismoid: "Prismoid",
};

const RECENT_MESSAGES_URL = "https://recent-messages.robotty.de/";
const PRIVACY_URL = "https://prismoid.org/privacy";

// Current version, the result of the last check, and the one button that
// does whatever comes next: check, install, or try again.
const UpdateRow: Component = () => {
  const [version, setVersion] = createSignal("");
  onMount(() => {
    getVersion()
      .then(setVersion)
      .catch((err: unknown) => console.error("app version", err));
  });

  const status = () => {
    const s = updateState();
    switch (s.kind) {
      case "idle":
        return "Checks on launch, every half hour, and when you come back";
      case "checking":
        return "Looking for updates";
      case "none":
        return "You're on the latest version";
      case "available":
        return `Version ${s.version} is available`;
      case "downloading":
        return s.total
          ? `Downloading ${Math.round((s.received / s.total) * 100)}%`
          : "Downloading";
      case "ready":
        return "Restarting to finish the update";
      case "error":
        return s.message;
    }
  };

  const action = () => {
    const kind = updateState().kind;
    if (kind === "available") return "Install and restart";
    if (kind === "checking" || kind === "downloading" || kind === "ready")
      return null;
    return "Check for updates";
  };

  return (
    <div class="settings__row">
      <div class="settings__text">
        <span class="settings__name">
          Prismoid {version() ? `v${version()}` : ""}
        </span>
        <span class="settings__hint">{status()}</span>
      </div>
      <Show when={notesFor(version())}>
        {(n) => (
          <button
            type="button"
            class="btn btn--outline"
            onClick={() => showPatchNotes(n())}
          >
            What's new
          </button>
        )}
      </Show>
      <Show when={action()}>
        {(label) => (
          <button
            type="button"
            class="btn btn--outline"
            onClick={() =>
              void (updateState().kind === "available"
                ? installUpdate()
                : checkForUpdates(true))
            }
          >
            {label()}
          </button>
        )}
      </Show>
    </div>
  );
};

// Windows owns this flag (Task Manager can flip it too), so it is read
// from the system each time Settings opens rather than stored here.
const StartupRow: Component<{ run: (p: Promise<void>) => void }> = (props) => {
  // equals: false so a failed toggle snaps the switch back even though
  // the value read from Windows did not change.
  const [on, setOn] = createSignal(false, { equals: false });
  const refresh = () =>
    isAutostartEnabled()
      .then(setOn)
      .catch((err: unknown) => console.error("autostart state", err));
  onMount(() => void refresh());

  return (
    <label class="settings__row settings__row--toggle">
      <div class="settings__text">
        <span class="settings__name">Start with Windows</span>
        <span class="settings__hint">
          Opens quietly in the tray when you sign in
        </span>
      </div>
      <input
        type="checkbox"
        class="switch"
        checked={on()}
        onChange={(e) => {
          props.run(
            (e.currentTarget.checked
              ? enableAutostart()
              : disableAutostart()
            ).finally(refresh),
          );
        }}
      />
    </label>
  );
};

const Settings: Component<SettingsProps> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  let dialogRef: HTMLDivElement | undefined;

  // Focus the dialog itself so Escape works before any control is tabbed to.
  createEffect(() => {
    if (props.open) queueMicrotask(() => dialogRef?.focus());
  });

  const run = (p: Promise<void>) => {
    setError(null);
    p.catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <Show when={props.open}>
      <div class="dialog-backdrop" onMouseDown={props.onClose}>
        <div
          ref={(el) => (dialogRef = el)}
          tabIndex={-1}
          class="dialog settings"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <div class="dialog__title">
            Settings
            <button
              type="button"
              class="icon-btn"
              aria-label="Close settings"
              onClick={props.onClose}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
              >
                <path
                  d="M2 2l8 8M10 2l-8 8"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>

          <div class="dialog__label">Accounts</div>
          <div class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Twitch</span>
              <span class="settings__hint">Signed in as {props.login}</span>
            </div>
            <button
              type="button"
              class="btn btn--outline btn--danger"
              onClick={props.onSignOut}
            >
              Sign out
            </button>
          </div>
          <Show when={missingScopes().length > 0}>
            <TwitchReconnect />
          </Show>

          <div class="dialog__label">Appearance</div>
          <div class="settings__row settings__row--stack">
            <span class="settings__name">Theme</span>
            <div class="settings__chips" role="group" aria-label="Theme">
              <For each={THEMES}>
                {(t) => (
                  <button
                    type="button"
                    class="modbar__chip"
                    classList={{ "modbar__chip--on": settings().theme === t }}
                    aria-pressed={settings().theme === t}
                    onClick={() => run(updateSettings({ theme: t }))}
                  >
                    {THEME_LABELS[t]}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Chat text size</span>
              <span class="settings__hint">
                Ctrl + scroll, or Ctrl with + − 0
              </span>
            </div>
            <div class="settings__zoom">
              <button
                type="button"
                class="icon-btn"
                aria-label="Smaller text"
                onClick={() => run(textSmaller())}
              >
                −
              </button>
              <button
                type="button"
                class="settings__zoom-value"
                title="Reset text size"
                onClick={() => run(textReset())}
              >
                {Math.round((settings().textSize / DEFAULT_TEXT_SIZE) * 100)}%
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label="Bigger text"
                onClick={() => run(textBigger())}
              >
                +
              </button>
            </div>
          </div>
          <div class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Zoom</span>
              <span class="settings__hint">Makes the whole window bigger</span>
            </div>
            <div class="settings__zoom">
              <button
                type="button"
                class="icon-btn"
                aria-label="Zoom out"
                onClick={() => run(zoomOut())}
              >
                −
              </button>
              <button
                type="button"
                class="settings__zoom-value"
                title="Reset zoom"
                onClick={() => run(zoomReset())}
              >
                {Math.round(settings().zoom * 100)}%
              </button>
              <button
                type="button"
                class="icon-btn"
                aria-label="Zoom in"
                onClick={() => run(zoomIn())}
              >
                +
              </button>
            </div>
          </div>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Timestamps</span>
              <span class="settings__hint">
                Show the time next to each message
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().showTimestamps}
              onChange={(e) =>
                run(updateSettings({ showTimestamps: e.currentTarget.checked }))
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Alternating rows</span>
              <span class="settings__hint">
                Shade every other message so busy chat is easier to follow
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().alternateRows}
              onChange={(e) =>
                run(updateSettings({ alternateRows: e.currentTarget.checked }))
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Load earlier messages</span>
              <span class="settings__hint">
                When you open a channel, fetch what was said before you joined
                from{" "}
                <button
                  type="button"
                  class="settings__link"
                  onClick={() =>
                    void openUrl(RECENT_MESSAGES_URL).catch((err: unknown) =>
                      console.error("failed to open link:", err),
                    )
                  }
                >
                  recent-messages.robotty.de
                </button>
                , a community service that logs Twitch chat
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().chatBacklog}
              onChange={(e) =>
                run(updateSettings({ chatBacklog: e.currentTarget.checked }))
              }
            />
          </label>

          <div class="dialog__label">Chat</div>
          <label class="settings__row settings__row--stack">
            <div class="settings__text">
              <span class="settings__name">Highlight phrases</span>
              <span class="settings__hint">
                Comma separated. Messages containing one light up like a
                mention.
              </span>
            </div>
            <input
              type="text"
              class="settings__input"
              placeholder="prismoid, gg"
              value={settings().highlightPhrases.join(", ")}
              onChange={(e) =>
                run(
                  updateSettings({
                    highlightPhrases: parseList(e.currentTarget.value),
                  }),
                )
              }
            />
          </label>
          <label class="settings__row settings__row--stack">
            <div class="settings__text">
              <span class="settings__name">Highlighted users</span>
              <span class="settings__hint">
                Comma separated logins. Everything they say stands out.
              </span>
            </div>
            <input
              type="text"
              class="settings__input"
              placeholder="bestfriend, cohost"
              value={settings().highlightUsers.join(", ")}
              onChange={(e) =>
                run(
                  updateSettings({
                    highlightUsers: parseList(e.currentTarget.value, true),
                  }),
                )
              }
            />
          </label>
          <div class="settings__row settings__row--stack">
            <span class="settings__name">Highlight by badge</span>
            <div
              class="settings__chips"
              role="group"
              aria-label="Highlight by badge"
            >
              <For each={HIGHLIGHT_BADGES}>
                {(b) => {
                  const on = () => settings().highlightBadges.includes(b);
                  return (
                    <button
                      type="button"
                      class="modbar__chip"
                      classList={{ "modbar__chip--on": on() }}
                      aria-pressed={on()}
                      onClick={() =>
                        run(
                          updateSettings({
                            highlightBadges: on()
                              ? settings().highlightBadges.filter(
                                  (x) => x !== b,
                                )
                              : [...settings().highlightBadges, b],
                          }),
                        )
                      }
                    >
                      {BADGE_LABELS[b]}
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
          <label class="settings__row settings__row--stack">
            <div class="settings__text">
              <span class="settings__name">Ignored users</span>
              <span class="settings__hint">
                Comma separated logins. Their messages never show.
              </span>
            </div>
            <input
              type="text"
              class="settings__input"
              placeholder="somebot, spammer"
              value={settings().ignoredLogins.join(", ")}
              onChange={(e) =>
                run(
                  updateSettings({
                    ignoredLogins: parseList(e.currentTarget.value, true),
                  }),
                )
              }
            />
          </label>
          <label class="settings__row settings__row--stack">
            <div class="settings__text">
              <span class="settings__name">Timeout buttons</span>
              <span class="settings__hint">
                Comma separated lengths shown on messages, menus and user cards.
                The first one is the hover button.
              </span>
            </div>
            <input
              type="text"
              class="settings__input"
              placeholder="1m, 10m, 1h, 1d"
              value={settings().timeoutPresets.map(formatSeconds).join(", ")}
              onChange={(e) => {
                const presets = parseDurations(e.currentTarget.value);
                if (presets) run(updateSettings({ timeoutPresets: presets }));
                else
                  e.currentTarget.value = settings()
                    .timeoutPresets.map(formatSeconds)
                    .join(", ");
              }}
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Moderator actions in chat</span>
              <span class="settings__hint">
                Show timeouts, bans and deletions as they happen. In channels
                you moderate this includes who did it and why
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().showModActions}
              onChange={(e) =>
                run(updateSettings({ showModActions: e.currentTarget.checked }))
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Ping when mentioned</span>
              <span class="settings__hint">
                A short chime and a flashing taskbar button when someone
                mentions you while prismoid is in the background
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().mentionAlerts}
              onChange={(e) =>
                run(updateSettings({ mentionAlerts: e.currentTarget.checked }))
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Flag new accounts</span>
              <span class="settings__hint">
                Mark messages from accounts created in the last week
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().flagNewAccounts}
              onChange={(e) =>
                run(
                  updateSettings({ flagNewAccounts: e.currentTarget.checked }),
                )
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Highlight first-time chatters</span>
              <span class="settings__hint">
                Mark someone's first message in a channel. Uses a separate
                read-only connection to Twitch chat
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().highlightFirstMessages}
              onChange={(e) =>
                run(
                  updateSettings({
                    highlightFirstMessages: e.currentTarget.checked,
                  }),
                )
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Show 7TV name paints</span>
              <span class="settings__hint">
                Fill names with the gradient or image a chatter picked on 7TV.
                Connects to 7TV while on
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().showPaints}
              onChange={(e) =>
                run(updateSettings({ showPaints: e.currentTarget.checked }))
              }
            />
          </label>

          <div class="dialog__label">Window</div>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Keep on top</span>
              <span class="settings__hint">
                Stay above games and other windows
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().alwaysOnTop}
              onChange={(e) =>
                run(updateSettings({ alwaysOnTop: e.currentTarget.checked }))
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Follow my browser</span>
              <span class="settings__hint">
                Open the Twitch channel showing in the front browser window
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().followBrowser}
              onChange={(e) =>
                run(updateSettings({ followBrowser: e.currentTarget.checked }))
              }
            />
          </label>
          <label class="settings__row settings__row--toggle">
            <div class="settings__text">
              <span class="settings__name">Close to tray</span>
              <span class="settings__hint">
                The X hides Prismoid; quit from the tray icon
              </span>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={settings().closeToTray}
              onChange={(e) =>
                run(updateSettings({ closeToTray: e.currentTarget.checked }))
              }
            />
          </label>
          <StartupRow run={run} />

          <div class="dialog__label">Updates</div>
          <UpdateRow />

          <div class="dialog__label">Help</div>
          <div class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Welcome tour</span>
              <span class="settings__hint">
                A one-minute walk through tabs, moderation and the switches
                worth turning on.
              </span>
            </div>
            <button
              type="button"
              class="btn btn--outline"
              onClick={() => {
                props.onClose();
                startTour();
              }}
            >
              Take the tour
            </button>
          </div>

          <div class="dialog__label">Logs</div>
          <div class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Log file</span>
              <span class="settings__hint">
                Connection and error details. Attach the newest file to a bug
                report.
              </span>
            </div>
            <button
              type="button"
              class="btn btn--outline"
              onClick={() => run(openLogDir())}
            >
              Open folder
            </button>
          </div>

          <div class="dialog__label">About</div>
          <div class="settings__row">
            <div class="settings__text">
              <span class="settings__name">Privacy</span>
              <span class="settings__hint">
                What stays on this computer and which services the app talks to.
              </span>
            </div>
            <button
              type="button"
              class="btn btn--outline"
              onClick={() => run(openUrl(PRIVACY_URL))}
            >
              Read policy
            </button>
          </div>

          <Show when={error()}>
            {(e) => (
              <div class="dialog__error" role="alert">
                {e()}
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
};

/**
 * Runs the sign-in again from inside Settings when the stored grant
 * predates a scope the app now needs. The existing tokens stay in place
 * until Twitch hands back the new ones, so cancelling costs nothing.
 */
const TwitchReconnect: Component = () => {
  const [pending, setPending] = createSignal<LoginView | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let generation = 0;

  const openTwitch = (url: string) =>
    openTwitchUrl(url).catch((err: unknown) => {
      console.error("open twitch", err);
      setError(`Your browser did not open. Copy this link into it: ${url}`);
    });

  const begin = async () => {
    const gen = ++generation;
    setError(null);
    setBusy(true);
    try {
      const view = await startLogin();
      if (gen !== generation) return;
      setPending(view);
      openTwitch(view.authorize_url);
      const status = await completeLogin();
      if (gen !== generation) return;
      setAuthStatus(status);
    } catch (e) {
      if (gen !== generation) return;
      setError(
        isAuthError(e)
          ? authErrorMessage(e)
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      if (gen === generation) {
        setBusy(false);
        setPending(null);
      }
    }
  };

  const cancel = () => {
    generation++;
    setPending(null);
    setBusy(false);
    void cancelLogin().catch((err: unknown) =>
      console.error("cancel reconnect", err),
    );
  };

  onCleanup(() => {
    if (busy()) cancel();
  });

  return (
    <div class="settings__row settings__row--stack settings__reconnect">
      <div class="settings__text">
        <span class="settings__name">Twitch needs new permissions</span>
        <span class="settings__hint">
          Features added since you signed in (moderation, your follow list) need
          extra access. Reconnect once to grant it.
        </span>
      </div>
      <Show
        when={pending()}
        fallback={
          <button
            type="button"
            class="btn btn--primary"
            disabled={busy()}
            onClick={() => void begin()}
          >
            Reconnect Twitch
          </button>
        }
      >
        {(p) => (
          <div class="settings__reconnect-wait">
            <span class="settings__hint">
              Choose Authorize in the browser tab that opened, then let it open
              prismoid.{" "}
              <a
                href={p().authorize_url}
                onClick={(e) => {
                  e.preventDefault();
                  openTwitch(p().authorize_url);
                }}
              >
                Open it again
              </a>
            </span>
            <button type="button" class="btn btn--outline" onClick={cancel}>
              Cancel
            </button>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(e) => (
          <div class="dialog__error" role="alert">
            {e()}
          </div>
        )}
      </Show>
    </div>
  );
};

export default Settings;
