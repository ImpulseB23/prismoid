// Tab strip under the header: one tab per open channel with its avatar,
// name, unread count and a close control, plus a button that opens the
// picker. Ctrl+Tab cycles, Ctrl+1..9 jump, Ctrl+W closes, middle click
// closes.

import {
  Component,
  For,
  Show,
  createEffect,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  activeChannel,
  channelTabs,
  closeChannel,
  focusChannel,
  unreadCount,
} from "../stores/channelStore";
import { openPicker, pickerLoading, prefetchLive } from "../stores/pickerStore";

const report = (what: string) => (err: unknown) => console.error(what, err);

const ChannelTabs: Component = () => {
  let strip: HTMLDivElement | undefined;
  const tabEls = new Map<string, HTMLElement>();

  // The active tab draws its own underline, so it always matches the tab's
  // width. On a switch it slides over from the old tab (FLIP): it starts
  // where the old underline was and eases into place.
  createEffect(
    on(
      () => activeChannel()?.id,
      (id, prev) => {
        if (id === undefined || prev === undefined || id === prev) return;
        const from = tabEls.get(prev);
        const to = tabEls.get(id);
        if (!from || !to || to.offsetWidth === 0) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        to.animate?.(
          [
            {
              transform: `translateX(${from.offsetLeft - to.offsetLeft}px) scaleX(${from.offsetWidth / to.offsetWidth})`,
            },
            { transform: "none" },
          ],
          {
            duration: 240,
            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
            pseudoElement: "::after",
          },
        );
      },
    ),
  );

  const show = (id: string) =>
    void focusChannel(id).catch(report("focus channel"));
  const close = (id: string) =>
    void closeChannel(id).catch(report("close channel"));

  const cycle = (step: number) => {
    const tabs = channelTabs();
    if (tabs.length < 2) return;
    const current = tabs.findIndex((c) => c.id === activeChannel()?.id);
    const next = tabs[(current + step + tabs.length) % tabs.length];
    if (next) show(next.id);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "w" || e.key === "W") {
        const active = activeChannel();
        if (!active) return;
        e.preventDefault();
        close(active.id);
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const tab = channelTabs()[Number(e.key) - 1];
        if (!tab) return;
        e.preventDefault();
        show(tab.id);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // The strip scrolls sideways; a plain wheel over it should move it.
  const onWheel = (e: WheelEvent) => {
    if (!strip || e.deltaY === 0 || e.ctrlKey) return;
    e.preventDefault();
    strip.scrollLeft += e.deltaY;
  };

  return (
    <div class="tabs" role="tablist" aria-label="Open channels">
      <div class="tabs__strip" ref={(el) => (strip = el)} onWheel={onWheel}>
        <For each={channelTabs()}>
          {(channel) => {
            const active = () => activeChannel()?.id === channel.id;
            const unread = () => unreadCount(channel.id);
            return (
              <div
                ref={(el) => {
                  tabEls.set(channel.id, el);
                  onCleanup(() => tabEls.delete(channel.id));
                }}
                class="tab"
                classList={{ "tab--active": active() }}
                role="tab"
                aria-selected={active()}
                title={channel.display_name}
                onClick={() => show(channel.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) close(channel.id);
                }}
              >
                <Show
                  when={channel.profile_image_url}
                  fallback={<span class="tab__avatar" />}
                >
                  {(url) => <img class="tab__avatar" src={url()} alt="" />}
                </Show>
                <span class="tab__name">{channel.display_name}</span>
                <Show when={!active() && unread() > 0}>
                  <span class="tab__unread" aria-label={`${unread()} new`}>
                    {unread() > 99 ? "99+" : unread()}
                  </span>
                </Show>
                <button
                  type="button"
                  class="tab__close"
                  aria-label={`Close ${channel.display_name}`}
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(channel.id);
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
                    <path
                      d="M2 2l6 6M8 2l-6 6"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <button
        type="button"
        class="tabs__add"
        data-tour="add-channel"
        title="Open a channel (Ctrl+K)"
        aria-label="Open a channel"
        aria-busy={pickerLoading()}
        onPointerEnter={() => void prefetchLive()}
        onClick={openPicker}
      >
        <Show
          when={!pickerLoading()}
          fallback={<span class="palette__spinner" aria-hidden="true" />}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M6 1.5v9M1.5 6h9"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </Show>
      </button>
    </div>
  );
};

export default ChannelTabs;
