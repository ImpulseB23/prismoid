// Root of the stream manager window: everything a streamer runs on their
// own channel, in a window they can keep on a second monitor. It is its own
// page, so it reads the account and the stream itself instead of borrowing
// the main window's stores, follows sign-ins made over there, and hears the
// poll, prediction and ad updates the host sends to every window.

import {
  Component,
  Match,
  Show,
  Switch,
  createEffect,
  createRenderEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { getAuthStatus, onAuthChanged } from "./lib/twitchAuth";
import { streamManagerReady } from "./lib/streamManagerWindow";
import { installContextMenus } from "./lib/appContextMenu";
import type { ChatEvent } from "./lib/chatEvents";
import {
  authStatus,
  currentUserId,
  scopeGroupReady,
  setAuthStatus,
  streamManagerNeedsReconnect,
} from "./stores/authStore";
import {
  applyPollUpdate,
  applyPredictionUpdate,
  clearStreamManager,
  currentPoll,
  currentPrediction,
  loadStreamManager,
} from "./stores/streamManagerStore";
import {
  applyAdBreak,
  clearAds,
  currentAdBreak,
  trackAdSchedule,
} from "./stores/adStore";
import { clearStreamLog, followStreamLog } from "./stores/streamLogStore";
import { createStreamStore } from "./stores/streamStore";
import { logo, palette } from "./stores/themeStore";
import { trackWindowChrome } from "./stores/windowStore";
import WindowControls from "./components/WindowControls";
import ContextMenu from "./components/ContextMenu";
import TwitchReconnect from "./components/TwitchReconnect";
import NowStrip from "./components/streamManager/NowStrip";
import SectionNav, {
  type Section,
} from "./components/streamManager/SectionNav";
import StreamSetup from "./components/streamManager/StreamSetup";
import QuickActions from "./components/streamManager/QuickActions";
import RunningNow from "./components/streamManager/RunningNow";

const report = (what: string) => (err: unknown) => console.error(what, err);

const StreamManagerWindow: Component = () => {
  const [section, setSection] = createSignal<Section>("live");
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  createRenderEffect(() => {
    document.documentElement.dataset.theme = palette();
  });

  const stream = createStreamStore();
  stream.track(() => currentUserId() ?? undefined);

  const adsReady = () => scopeGroupReady("ads");

  // Loads for the signed-in account, again after a reconnect adds the
  // permission, and drops the old account's data on a switch.
  createEffect(
    on(
      () => (streamManagerNeedsReconnect() ? null : currentUserId()),
      (owner) => {
        clearStreamManager();
        if (owner !== null) void loadStreamManager();
      },
    ),
  );
  createEffect(
    on(
      () => (adsReady() ? currentUserId() : null),
      (owner) => {
        clearAds();
        if (owner !== null) onCleanup(trackAdSchedule());
      },
    ),
  );
  createEffect(on(currentUserId, () => clearStreamLog(), { defer: true }));
  followStreamLog({
    adBreak: currentAdBreak,
    poll: currentPoll,
    prediction: currentPrediction,
  });

  onMount(() => onCleanup(installContextMenus()));

  const stops: (() => void)[] = [];
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    for (const stop of stops) stop();
  });
  const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
  onMount(() => {
    trackWindowChrome().then(keep).catch(report("window chrome"));
    onAuthChanged(setAuthStatus).then(keep).catch(report("auth changes"));
    // Only the user's own channel sends these, so they go straight to the
    // stores, which drop anything for another account.
    listen<ChatEvent[]>("chat_events", (event) => {
      for (const e of event.payload) {
        if (e.kind === "poll_update") applyPollUpdate(e);
        else if (e.kind === "prediction_update") applyPredictionUpdate(e);
        else if (e.kind === "ad_break") applyAdBreak(e);
      }
    })
      .then(keep)
      .catch(report("chat events"));
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
          <NowStrip info={stream.info()} now={now()} adsReady={adsReady()} />
          <SectionNav current={section()} onPick={setSection} />
          <main class="sm__content">
            <Show
              when={!streamManagerNeedsReconnect()}
              fallback={
                <TwitchReconnect
                  title="The stream manager needs a new Twitch permission"
                  hint="Editing your stream, polls and predictions came after you signed in. Reconnect once to allow them."
                />
              }
            >
              <Switch>
                <Match when={section() === "live"}>
                  <div class="sm-cols">
                    <div class="sm-col sm-col--main">
                      <StreamSetup />
                    </div>
                    <div class="sm-col">
                      <QuickActions live={stream.info()?.is_live === true} />
                      <RunningNow now={now()} />
                    </div>
                  </div>
                </Match>
              </Switch>
            </Show>
          </main>
        </Match>
      </Switch>
      <ContextMenu />
    </div>
  );
};

export default StreamManagerWindow;
