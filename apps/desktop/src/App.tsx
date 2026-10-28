import {
  Component,
  Match,
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
import ModBar from "./components/ModBar";
import StreamBar from "./components/StreamBar";
import Tour from "./components/Tour";
import PatchNotes from "./components/PatchNotes";
import { offerTour } from "./stores/tourStore";
import { logo, palette } from "./stores/themeStore";
import SignIn from "./components/SignIn";
import UpdateNotice from "./components/UpdateNotice";
import UpdateScreen from "./components/UpdateScreen";
import { getAuthStatus, logout } from "./lib/twitchAuth";
import {
  authStatus,
  moderationNeedsReconnect,
  setAuthStatus,
} from "./stores/authStore";
import {
  activeChannel,
  restoreChannels,
  selectChannel,
} from "./stores/channelStore";
import { clearMessages } from "./stores/chatStore";
import { clearMentions } from "./stores/mentionsStore";
import { clearRoles, loadModeratedChannels } from "./stores/roleStore";
import { trackActiveStream } from "./stores/streamStore";
import { initWhatsNew } from "./stores/whatsNewStore";
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
  onMount(() => {
    initWhatsNew().catch((err: unknown) => console.error("whats new", err));
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
    clearMentions();
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
      <UpdateScreen
        state={updateState}
        onRetry={() => void installUpdate()}
        onDismiss={dismissUpdate}
      />
    </div>
  );
};

const ChatShell: Component<{ login: string; onSignOut: () => void }> = (
  props,
) => {
  trackActiveStream();

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
      <ChatFeed login={props.login} />
      <MessageInput login={props.login} />
      <ModBar />
      <Tour />
      <PatchNotes />
    </>
  );
};

export default App;
