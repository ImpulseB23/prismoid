// The command center for channels the user streams or moderates: a small
// tab on the right edge of the chat that slides out a panel with the room
// modes (Clear chat at their foot), the AutoMod queue and the mod log. Everything opens in
// place inside the panel, one section at a time, so nothing stacks a second
// window on top. Kept apart from the composer so chatting stays uncluttered.

import {
  Component,
  JSX,
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

type Section = "modes" | "automod" | "log";

const Chevron: Component = () => (
  <svg
    class="cc__chevron"
    width="10"
    height="10"
    viewBox="0 0 10 10"
    aria-hidden="true"
  >
    <path
      d="M2.5 3.75 5 6.25l2.5-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

const CommandCenter: Component = () => {
  // The only owner of the modes store: it follows the channel on screen.
  createEffect(() => {
    const id = activeChannel()?.id;
    if (id !== undefined && canModerate()) void loadChatSettings(id);
    else clearChatSettings();
  });

  const [open, setOpen] = createSignal(false);
  const [section, setSection] = createSignal<Section | null>(null);
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
  // modes dropdowns open in the top layer, outside the panel's box, so a
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

  const toggle = (s: Section) => setSection((cur) => (cur === s ? null : s));

  const SectionHead = (p: {
    id: Section;
    title: JSX.Element;
    desc: JSX.Element;
    on?: boolean;
  }) => (
    <button
      type="button"
      class="cc__item"
      classList={{
        "cc__item--on": p.on === true,
        "cc__item--open": section() === p.id,
      }}
      aria-expanded={section() === p.id}
      onClick={() => toggle(p.id)}
    >
      <span class="cc__item-text">
        <span class="cc__title">{p.title}</span>
        <span class="cc__desc">{p.desc}</span>
      </span>
      <Chevron />
    </button>
  );

  return (
    <Show when={canModerate()}>
      <button
        ref={(el) => (handleRef = el)}
        type="button"
        class="cc-handle"
        classList={{ "cc-handle--open": open() }}
        data-tour="chat-modes"
        aria-label="Command center"
        aria-expanded={open()}
        title="Command center"
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
          class="cc"
          aria-label="Command center"
        >
          <div class="cc__head">
            <span
              class="modbar__role"
              classList={{ "modbar__role--owner": broadcaster() }}
            >
              {broadcaster() ? "Your channel" : "Moderator"}
            </span>
            <button
              type="button"
              class="icon-btn"
              aria-label="Close command center"
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

          <div class="cc__sections">
            <SectionHead
              id="modes"
              on={activeSummary(chatSettings()) !== null}
              title="Chat modes"
              desc={
                activeSummary(chatSettings()) ?? "Open chat, anyone can talk"
              }
            />
            <Show when={section() === "modes"}>
              <ChatModes />
              {/* Rare and drastic, so it lives at the bottom of the modes
                  rather than on the panel's face, and takes a second tap. */}
              <div class="cc__danger">
                <button
                  type="button"
                  class="btn btn--small btn--danger"
                  classList={{ "btn--armed": armed() }}
                  disabled={clearing()}
                  onClick={() => void onClear()}
                >
                  {armed() ? "Tap again to clear for everyone" : "Clear chat"}
                </button>
                <Show when={clearError()}>
                  {(msg) => (
                    <span class="modbar__error" role="alert">
                      {msg()}
                    </span>
                  )}
                </Show>
              </div>
            </Show>

            <SectionHead
              id="automod"
              title={
                <>
                  AutoMod
                  <Show when={heldCount() > 0}>
                    <span class="modbar__count">{heldCount()}</span>
                  </Show>
                </>
              }
              desc={
                heldCount() > 0
                  ? `${heldCount()} held for review`
                  : "Nothing waiting for review"
              }
            />
            <Show when={section() === "automod"}>
              <AutomodQueue />
            </Show>

            <SectionHead
              id="log"
              title="Mod log"
              desc="Every timeout, ban and deletion this session"
            />
            <Show when={section() === "log"}>
              <ModLog />
            </Show>
          </div>
        </aside>
      </Show>
    </Show>
  );
};

export default CommandCenter;
