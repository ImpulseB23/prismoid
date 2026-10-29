// The chat manager for channels the user streams or moderates: a small tab
// on the right edge of the chat that slides out a panel with the room modes
// as tiles, the AutoMod queue and the mod log as tabs, and Clear chat at the
// foot. Everything stays inside the panel, so nothing stacks a second
// window on top. Stream controls live in the stream manager window instead.

import {
  Component,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { activeChannel } from "../stores/channelStore";
import { currentUserId } from "../stores/authStore";
import { canModerate } from "../stores/roleStore";
import {
  chatSettings,
  clearChatSettings,
  loadChatSettings,
} from "../stores/chatSettingsStore";
import ChatModes from "./ChatModes";
import ModLog from "./ModLog";
import AutomodQueue from "./AutomodQueue";
import { pendingHeldCount } from "../stores/automodStore";
import { activeSummary } from "../lib/chatModes";
import { clearChat, type SendMessageError } from "../lib/twitchAuth";
import { formatSendError, toSendError } from "../lib/messageInput";
import { createConfirmTap } from "../lib/confirmTap";

type Tab = "held" | "log";

const CommandCenter: Component = () => {
  // The only owner of the modes store: it follows the channel on screen.
  createEffect(() => {
    const id = activeChannel()?.id;
    if (id !== undefined && canModerate()) void loadChatSettings(id);
    else clearChatSettings();
  });

  const [open, setOpen] = createSignal(false);
  const [tab, setTab] = createSignal<Tab>("held");
  const broadcaster = () => activeChannel()?.id === currentUserId();
  const heldCount = () => {
    const id = activeChannel()?.id;
    return id === undefined ? 0 : pendingHeldCount(id);
  };

  const { armed, tap, disarm } = createConfirmTap();
  const [clearing, setClearing] = createSignal(false);
  const [clearError, setClearError] = createSignal<string | null>(null);

  createEffect(
    on(
      () => activeChannel()?.id,
      () => {
        disarm();
        setClearError(null);
      },
    ),
  );

  // While open, Escape or a click back in the chat closes the panel. The
  // duration dropdowns open in the top layer, outside the panel's box, so a
  // click inside one must not count as a click outside.
  let panelRef: HTMLElement | undefined;
  let handleRef: HTMLButtonElement | undefined;
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (t instanceof Element && t.closest("select, option")) return;
      if (!panelRef?.contains(t) && !handleRef?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    });
  });

  const onClear = async () => {
    const id = activeChannel()?.id;
    if (id === undefined) return;
    if (!tap()) {
      setClearError(null);
      return;
    }
    setClearing(true);
    try {
      await clearChat(id);
    } catch (raw) {
      const err = toSendError(raw);
      setClearError(
        typeof err === "string"
          ? err
          : formatSendError(err as SendMessageError),
      );
    } finally {
      setClearing(false);
    }
  };

  const summary = () => activeSummary(chatSettings());

  return (
    <Show when={canModerate()}>
      <button
        ref={(el) => (handleRef = el)}
        type="button"
        class="cc-handle"
        classList={{ "cc-handle--open": open() }}
        data-tour="chat-modes"
        aria-label="Chat manager"
        aria-expanded={open()}
        title="Chat manager"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
          <path
            d="M7 2 2 7l5 5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <Show when={heldCount() > 0}>
          <span class="cc-handle__count">{heldCount()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <aside
          ref={(el) => (panelRef = el)}
          class="cm"
          aria-label="Chat manager"
        >
          <div class="cm__head">
            <Show
              when={activeChannel()?.profile_image_url}
              fallback={<span class="cm__avatar" />}
            >
              {(url) => <img class="cm__avatar" src={url()} alt="" />}
            </Show>
            <span class="cm__who">
              <span class="cm__title">Chat manager</span>
              <span class="cm__sub">
                {activeChannel()?.display_name},{" "}
                {broadcaster() ? "your channel" : "you moderate"}
              </span>
            </span>
            <button
              type="button"
              class="icon-btn"
              aria-label="Close chat manager"
              onClick={() => setOpen(false)}
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

          <section class="cm__room" aria-label="Room modes">
            <div class="cm__room-head">
              <span>Room</span>
              <span classList={{ "cm__summary--on": summary() !== null }}>
                {summary() ?? "Open, anyone can chat"}
              </span>
            </div>
            <ChatModes />
          </section>

          <div class="cm__tabs" role="tablist" aria-label="Chat manager lists">
            <button
              type="button"
              role="tab"
              class="cm__tab"
              classList={{ "cm__tab--on": tab() === "held" }}
              aria-selected={tab() === "held"}
              onClick={() => setTab("held")}
            >
              Held by AutoMod
              <Show when={heldCount() > 0}>
                <span class="modbar__count">{heldCount()}</span>
              </Show>
            </button>
            <button
              type="button"
              role="tab"
              class="cm__tab"
              classList={{ "cm__tab--on": tab() === "log" }}
              aria-selected={tab() === "log"}
              onClick={() => setTab("log")}
            >
              Mod log
            </button>
          </div>

          <div class="cm__list" role="tabpanel">
            <Show when={tab() === "held"} fallback={<ModLog />}>
              <AutomodQueue />
            </Show>
          </div>

          {/* Rare and drastic, so it sits at the foot and takes a second
              tap. */}
          <div class="cm__foot">
            <span
              class="cm__foot-hint"
              classList={{ "cm__foot-hint--error": clearError() !== null }}
              role={clearError() !== null ? "alert" : undefined}
            >
              {clearError() ??
                (armed()
                  ? "Clears chat for everyone"
                  : "Rare, so it asks twice")}
            </span>
            <button
              type="button"
              class="btn btn--small btn--danger"
              classList={{ "btn--armed": armed() }}
              disabled={clearing()}
              onClick={() => void onClear()}
            >
              {armed() ? "Tap again to clear" : "Clear chat"}
            </button>
          </div>
        </aside>
      </Show>
    </Show>
  );
};

export default CommandCenter;
