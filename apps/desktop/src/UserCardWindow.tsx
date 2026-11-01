// Root of a user card window: a title bar to drag, pin, minimize and close
// it, and the user card below. The window loads its own data (see
// cardSession) and hands mentions and jumps to the main window.

import {
  Component,
  Show,
  createEffect,
  createRenderEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import UserCard, { type CardUser } from "./components/UserCard";
import ContextMenu from "./components/ContextMenu";
import EmoteCard from "./components/EmoteCard";
import EmoteTooltip from "./components/EmoteTooltip";
import { sendJump, sendMention } from "./lib/cardBridge";
import { showCardUser, startCardSession } from "./lib/cardSession";
import { preloadCardFacts } from "./lib/cardFacts";
import { createChatStore } from "./stores/chatStore";
import { createBadgeStore } from "./stores/badgeStore";
import { authStatus } from "./stores/authStore";
import { reapplyZoom, settings } from "./stores/settingsStore";
import {
  cardReady,
  closeUserCard,
  currentCardUser,
  onCardUser,
  setCardPinned,
} from "./lib/userCardWindow";
import { palette } from "./stores/themeStore";

const report = (what: string) => (err: unknown) => console.error(what, err);

const UserCardWindow: Component = () => {
  const [user, setUser] = createSignal<CardUser | null>(null);
  const [chat, setChat] = createSignal(createChatStore());
  const [badges, setBadges] = createSignal(createBadgeStore());
  const [pinned, setPinned] = createSignal(false);

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

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // The host updates the card before it announces a reuse, so an event
    // is always at least as new as the current() answer racing it.
    let announced = false;
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
    // The card shows, or moves to the next person, only once their profile
    // and sub are in, so it never opens half drawn. The newest wins.
    let seq = 0;
    let revealed = false;
    const reveal = () => {
      if (revealed || disposed) return;
      revealed = true;
      void cardReady().catch(report("failed to show card"));
    };
    const show = async (u: CardUser | null) => {
      const mine = ++seq;
      if (u) await preloadCardFacts(u);
      if (mine !== seq || disposed) return;
      setUser(u);
      reveal();
    };
    onCardUser((u) => {
      announced = true;
      void show(u);
    })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
        return currentCardUser();
      })
      .then((u) => (announced ? undefined : show(u)))
      .catch((err: unknown) => {
        report("failed to load user card")(err);
        reveal();
      });
  });

  onMount(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    onCleanup(() => {
      disposed = true;
      stop?.();
    });
    startCardSession()
      .then((s) => {
        if (disposed) s();
        else stop = s;
      })
      .catch(report("failed to start card session"));
  });

  // Each person shown loads their own history and mod log; a reuse for
  // someone else stops the previous one.
  createEffect(
    on(
      () => {
        const u = user();
        return u ? `${u.channel_id}:${u.platform_user_id}` : null;
      },
      (key) => {
        const u = user();
        if (!key || !u) return;
        let stop: (() => void) | undefined;
        let disposed = false;
        onCleanup(() => {
          disposed = true;
          stop?.();
        });
        const store = createChatStore();
        const badgeStore = createBadgeStore();
        setChat(store);
        setBadges(badgeStore);
        showCardUser(u, store, badgeStore)
          .then((s) => {
            if (disposed) s();
            else stop = s;
          })
          .catch(report("failed to load card"));
      },
    ),
  );

  // The same zoom as the main window: on open, whenever it changes, and on
  // a display with another scale.
  createEffect(
    on(
      () => settings().zoom,
      () => void reapplyZoom().catch(report("failed to apply card zoom")),
    ),
  );
  onMount(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    onCleanup(() => {
      disposed = true;
      off?.();
    });
    getCurrentWindow()
      .onScaleChanged(
        () => void reapplyZoom().catch(report("failed to apply card zoom")),
      )
      .then((next) => {
        if (disposed) next();
        else off = next;
      })
      .catch(report("failed to follow card scale"));
  });

  const login = () => {
    const a = authStatus();
    return a?.state === "logged_in" ? a.login : "";
  };

  const togglePin = () => {
    const next = !pinned();
    setCardPinned(next)
      .then(() => setPinned(next))
      .catch(report("failed to pin card"));
  };

  return (
    <div class="app">
      <UserCard
        user={user()}
        chat={chat()}
        badges={badges()}
        login={login()}
        onClose={() =>
          void closeUserCard().catch(report("failed to close card"))
        }
        onMention={sendMention}
        onJump={(m) => sendJump(m.channel_id, m.id)}
        controls={
          <>
            <button
              type="button"
              class="icon-btn"
              classList={{ "icon-btn--active": pinned() }}
              aria-pressed={pinned()}
              aria-label={pinned() ? "Unpin card" : "Pin card"}
              onClick={togglePin}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M6 2h4l-.5 4 2.5 2.5v1H9v4.5L8 15l-1-1V9.5H4v-1L6.5 6z"
                  fill="currentColor"
                />
              </svg>
            </button>
            {/* An unpinned card closes as soon as it loses focus, so only a
                pinned one can be minimized. */}
            <Show when={pinned()}>
              <button
                type="button"
                class="icon-btn"
                aria-label="Minimize card"
                onClick={() =>
                  void getCurrentWindow()
                    .minimize()
                    .catch(report("failed to minimize card"))
                }
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path d="M3 8h10v1.5H3z" fill="currentColor" />
                </svg>
              </button>
            </Show>
            <button
              type="button"
              class="icon-btn"
              aria-label="Close card"
              onClick={() =>
                void closeUserCard().catch(report("failed to close card"))
              }
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M4 3l4 4 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </>
        }
      />
      <ContextMenu />
      <EmoteCard />
      <EmoteTooltip />
    </div>
  );
};

export default UserCardWindow;
