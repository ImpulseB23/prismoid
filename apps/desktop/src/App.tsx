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
import SplitView from "./components/SplitView";
import Header from "./components/Header";
import StreamBar from "./components/StreamBar";
import StreamManager from "./components/streamManager/StreamManager";
import Tour from "./components/Tour";
import PatchNotes from "./components/PatchNotes";
import { offerTour } from "./stores/tourStore";
import { logo, palette } from "./stores/themeStore";
import SignIn from "./components/SignIn";
import UpdateNotice from "./components/UpdateNotice";
import UpdateScreen, { screenFor } from "./components/UpdateScreen";
import { getAuthStatus, logout, type AuthStatus } from "./lib/twitchAuth";
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
import { clearAds } from "./stores/adStore";
import { clearStreamLog } from "./stores/streamLogStore";
import { setStreamManagerOpen } from "./stores/streamManagerPanelStore";
import {
  isMentionFor,
  resetMentions,
  scanMentionHistory,
} from "./stores/mentionsStore";
import { clearRoles, loadModeratedChannels } from "./stores/roleStore";
import { trackActiveStream } from "./stores/streamStore";
import { loadOwnColor } from "./stores/ownIdentityStore";
import { initWhatsNew } from "./stores/whatsNewStore";
import { trackWindowChrome } from "./stores/windowStore";
import TitleBar from "./components/TitleBar";
import ContextMenu from "./components/ContextMenu";
import ModPopover from "./components/ModPopover";
import { installContextMenus } from "./lib/appContextMenu";
import { startChatRouter } from "./lib/chatRouter";
import { announceModLog, serveCards } from "./lib/cardBridge";
import { focusedPane } from "./lib/pane";
import EmoteCard from "./components/EmoteCard";
import EmoteTooltip from "./components/EmoteTooltip";
import ChatHoverCard from "./components/ChatHoverCard";
import { jumpToMessage } from "./stores/jumpStore";
import { modActionsFor, modLogRevision } from "./stores/modLogStore";
import { followSettingsElsewhere, settings } from "./stores/settingsStore";
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
  // Message lists outside the feed (cards, mentions, search) read the chat
  // text size from here.
  createRenderEffect(() => {
    document.documentElement.style.setProperty(
      "--chat-text",
      `${settings().textSize}px`,
    );
  });

  onMount(async () => {
    let status: AuthStatus;
    try {
      status = await getAuthStatus();
    } catch {
      // Treat any error from the status command as logged-out; the
      // SignIn flow surfaces a real error message if the underlying
      // keychain is broken.
      status = { state: "logged_out" };
    }
    // Before the chat mounts, so the setup tour knows a returning user.
    initWhatsNew(status.state === "logged_in").catch((err: unknown) =>
      console.error("whats new", err),
    );
    setAuthStatus(status);
  });

  // Runs for the whole session, sign-in screen included, so a release that
  // fixes a sign-in bug still reaches whoever is stuck there. Dev builds
  // skip it: the launch check would install the release over them.
  if (!import.meta.env.DEV) onMount(() => onCleanup(scheduleUpdateChecks()));
  onMount(() => onCleanup(installContextMenus()));
  // The listener resolves after an await, outside the owner, so the stop
  // function is kept and released from a cleanup registered up front.
  let stopChrome: (() => void) | undefined;
  onCleanup(() => stopChrome?.());
  onMount(() => {
    trackWindowChrome()
      .then((stop) => (stopChrome = stop))
      .catch((err: unknown) => console.error("window chrome", err));
  });

  // User card windows hand mentions and jumps over, ask for the mod log,
  // and save settings this window has to pick up.
  const cardStops: (() => void)[] = [];
  onCleanup(() => {
    for (const stop of cardStops) stop();
  });
  onMount(() => {
    Promise.all([
      serveCards({
        mention: (login) => focusedPane()?.composer.requestMention(login),
        jump: (j) => jumpToMessage(j.channel_id, j.message_id),
        modLogFor: modActionsFor,
      }),
      followSettingsElsewhere(),
    ])
      .then((stops) => cardStops.push(...stops))
      .catch((err: unknown) => console.error("user card windows", err));
  });
  createEffect(on(modLogRevision, announceModLog, { defer: true }));

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
    resetMentions();
    clearHeldMessages();
    clearStreamManager();
    clearAds();
    clearStreamLog();
    setStreamManagerOpen(false);
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
      <ModPopover />
      <EmoteCard />
      <EmoteTooltip />
      <ChatHoverCard />
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
    // Your name color for messages still being sent; your own messages
    // keep it current after this.
    loadOwnColor().catch((err: unknown) => console.error("own color", err));

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
    // Chat events for the whole window; each feed attaches for its channel.
    let stopRouter: (() => void) | undefined;
    void startChatRouter(() => props.login).then((fn) => {
      if (disposed) fn();
      else stopRouter = fn;
    });
    onCleanup(() => {
      disposed = true;
      unlisten?.();
      stopRouter?.();
    });
  });

  return (
    <>
      <Header login={props.login} onSignOut={props.onSignOut} />
      <div class="app__body">
        <ChannelTabs />
        <StreamBar />
        <SplitView login={props.login} />
        <Show when={settings().streamManager}>
          <StreamManager />
        </Show>
      </div>
      <Tour />
      <PatchNotes />
    </>
  );
};

export default App;
