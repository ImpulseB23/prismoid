import {
  Component,
  Match,
  Show,
  Switch,
  createEffect,
  createRenderEffect,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import ChannelTabs from "./components/ChannelTabs";
import ChatFeed from "./components/ChatFeed";
import Header from "./components/Header";
import MessageInput from "./components/MessageInput";
import CommandCenter from "./components/CommandCenter";
import StreamBar from "./components/StreamBar";
import Tour from "./components/Tour";
import PatchNotes from "./components/PatchNotes";
import { offerTour } from "./stores/tourStore";
import { logo, palette } from "./stores/themeStore";
import SignIn from "./components/SignIn";
import UpdateNotice from "./components/UpdateNotice";
import UpdateScreen, { screenFor } from "./components/UpdateScreen";
import { getAuthStatus, logout } from "./lib/twitchAuth";
import {
  authStatus,
  moderationNeedsReconnect,
  setAuthStatus,
} from "./stores/authStore";
import {
  activeChannel,
  channelTabs,
  restoreChannels,
  selectChannel,
} from "./stores/channelStore";
import { clearHeldMessages } from "./stores/automodStore";
import { clearStreamManager } from "./stores/streamManagerStore";
import { clearMessages } from "./stores/chatStore";
import {
  isMentionFor,
  resetMentions,
  scanMentionHistory,
} from "./stores/mentionsStore";
import { settings } from "./stores/settingsStore";
import { clearRoles, loadModeratedChannels } from "./stores/roleStore";
import { trackActiveStream } from "./stores/streamStore";
import { initWhatsNew } from "./stores/whatsNewStore";
import { trackWindowChrome } from "./stores/windowStore";
import TitleBar from "./components/TitleBar";
import ContextMenu from "./components/ContextMenu";
import { installContextMenus } from "./lib/appContextMenu";
import { settingsOpen } from "./stores/settingsPanelStore";
import {
  dismissUpdate,
  installUpdate,
  scheduleUpdateChecks,
  updateState,
} from "./stores/updateStore";

const App: Component = () => {
  // `null` = still loading initial status; the splash avoids a flash of
  // the SignIn overlay before the keychain check returns.
  const auth = authStatus;

  // Render effect so the palette is on <html> before the first paint.
  createRenderEffect(() => {
    document.documentElement.dataset.theme = palette();
  });

  onMount(async () => {
    try {
      setAuthStatus(await getAuthStatus());
    } catch {
      // Treat any error from the status command as logged-out; the
      // SignIn flow surfaces a real error message if the underlying
      // keychain is broken.
      setAuthStatus({ state: "logged_out" });
    }
  });

  // Runs for the whole session, sign-in screen included, so a release that
  // fixes a sign-in bug still reaches whoever is stuck there.
  onMount(() => onCleanup(scheduleUpdateChecks()));
  onMount(() => onCleanup(installContextMenus()));
  onMount(() => {
    initWhatsNew().catch((err: unknown) => console.error("whats new", err));
  });
  // The listener resolves after an await, outside the owner, so the stop
  // function is kept and released from a cleanup registered up front.
  let stopChrome: (() => void) | undefined;
  onCleanup(() => stopChrome?.());
  onMount(() => {
    trackWindowChrome()
      .then((stop) => (stopChrome = stop))
      .catch((err: unknown) => console.error("window chrome", err));
  });

  // The moderated-channel list needs its own scope, so it is fetched once
  // the session has it: at sign-in, and again after a reconnect that
  // added the scope.
  createEffect(
    on(
      () => {
        const a = auth();
        return a?.state === "logged_in" && !moderationNeedsReconnect()
          ? a.user_id
          : null;
      },
      (userId) => {
        if (userId) void loadModeratedChannels();
        else clearRoles();
      },
    ),
  );

  const signOut = async () => {
    await logout();
    clearMessages();
    resetMentions();
    clearHeldMessages();
    clearStreamManager();
    setAuthStatus({ state: "logged_out" });
  };

  return (
    <div class="app">
      <Switch>
        <Match when={auth() === null}>
          <div class="splash">
            <img src={logo()} alt="" />
          </div>
        </Match>
        <Match when={auth()?.state === "logged_out"}>
          <SignIn onAuthenticated={setAuthStatus} />
          <UpdateNotice
            state={updateState}
            onInstall={() => void installUpdate()}
          />
        </Match>
        <Match
          when={(() => {
            const a = auth();
            return a?.state === "logged_in" ? a : null;
          })()}
        >
          {(loggedIn) => (
            <ChatShell login={loggedIn().login} onSignOut={signOut} />
          )}
        </Match>
      </Switch>
      <ContextMenu />
      <UpdateScreen
        state={updateState}
        onRetry={() => void installUpdate()}
        onDismiss={dismissUpdate}
      />
      {/* The chat header carries the window buttons; every other screen gets the bare bar. */}
      <Show
        when={
          auth()?.state !== "logged_in" ||
          settingsOpen() ||
          screenFor(updateState()) !== null
        }
      >
        <TitleBar />
      </Show>
    </div>
  );
};

const ChatShell: Component<{ login: string; onSignOut: () => void }> = (
  props,
) => {
  trackActiveStream();

  // Mentions from before the app was open sit in each channel's stored
  // history (backlog included), and only the tab on screen loads its own.
  // Every open tab is looked through once, as it joins.
  createEffect(() => {
    const phrases = settings().highlightPhrases;
    const ignored = settings().ignoredLogins;
    for (const tab of channelTabs()) {
      void scanMentionHistory(tab.id, (m) =>
        isMentionFor(m, props.login, phrases, ignored),
      );
    }
  });

  onMount(() => {
    // Reopen last session's tabs, or the user's own chat on a fresh
    // install. Errors land in the channel store and surface through the
    // picker, so nothing to handle here.
    void restoreChannels(props.login);
    offerTour();

    // The host reports the channel open in the front browser window while
    // "Follow my browser" is on. Registration is async, so a disposal that
    // wins the race releases the late handle at once.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<{ platform: string; login: string }>("browser_stream", (evt) => {
      if (evt.payload.platform !== "twitch") return;
      if (activeChannel()?.login === evt.payload.login) return;
      void selectChannel(evt.payload.login).catch(() => {});
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("failed to listen for browser streams:", err),
      );
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });

  return (
    <>
      <Header login={props.login} onSignOut={props.onSignOut} />
      <ChannelTabs />
      <StreamBar />
      <div class="chat-area">
        <ChatFeed login={props.login} />
        <CommandCenter />
      </div>
      <MessageInput login={props.login} />
      <Tour />
      <PatchNotes />
    </>
  );
};

export default App;
