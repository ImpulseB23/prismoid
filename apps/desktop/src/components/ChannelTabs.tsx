// Tab strip under the header: one tab per open channel with its avatar,
// name, unread count and a close control, plus a button that opens the
// picker. Ctrl+Tab cycles, Ctrl+1..9 jump, Ctrl+W closes, middle click
// closes. A tab opens in a split from its right-click menu or by dragging
// it onto the panes.

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  activeChannel,
  channelTabs,
  closeChannel,
  focusChannel,
  keepChannel,
  moveChannelTab,
  previewChannelId,
  unreadCount,
} from "../stores/channelStore";
import { openPicker, pickerLoading, prefetchLive } from "../stores/pickerStore";
import {
  TAB_DRAG_TYPE,
  canSplitPane,
  draggedTab,
  dropPaneChannel,
  panes,
  setDraggedTab,
  splitPane,
} from "../stores/layoutStore";
import { item, openContextMenu } from "../stores/contextMenuStore";
import { settings } from "../stores/settingsStore";

const report = (what: string) => (err: unknown) => console.error(what, err);

const ChannelTabs: Component = () => {
  let strip: HTMLDivElement | undefined;
  const tabEls = new Map<string, HTMLElement>();
  // The tab a dragged tab would land beside, and on which side.
  const [dropAt, setDropAt] = createSignal<{
    id: string;
    after: boolean;
  } | null>(null);

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
  // Its pane goes first, so focus moves to the neighbouring pane rather
  // than the closing tab's neighbour taking over the pane.
  const close = (id: string) => {
    dropPaneChannel(id);
    void closeChannel(id).catch(report("close channel"));
  };
  const onScreen = (id: string) => panes().some((p) => p.channelId === id);

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
            const inOtherPane = () => !active() && onScreen(channel.id);
            const unread = () => unreadCount(channel.id);
            const preview = () => previewChannelId() === channel.id;
            return (
              <div
                ref={(el) => {
                  tabEls.set(channel.id, el);
                  onCleanup(() => tabEls.delete(channel.id));
                }}
                class="tab"
                classList={{
                  "tab--active": active(),
                  "tab--shown": inOtherPane(),
                  "tab--preview": preview(),
                  "tab--drop-before":
                    dropAt()?.id === channel.id && !dropAt()!.after,
                  "tab--drop-after":
                    dropAt()?.id === channel.id && dropAt()!.after,
                }}
                role="tab"
                aria-selected={active()}
                title={
                  preview()
                    ? `${channel.display_name}: follows your browser. Double-click to keep it.`
                    : channel.display_name
                }
                draggable={true}
                onDragStart={(e) => {
                  e.dataTransfer?.setData(TAB_DRAG_TYPE, channel.id);
                  setDraggedTab(channel.id);
                }}
                onDragEnd={() => {
                  setDraggedTab(null);
                  setDropAt(null);
                }}
                // Another tab dropped here moves before or after this one,
                // whichever half the pointer is over.
                onDragOver={(e) => {
                  if (
                    !e.dataTransfer?.types.includes(TAB_DRAG_TYPE) ||
                    draggedTab() === channel.id
                  ) {
                    return;
                  }
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropAt({
                    id: channel.id,
                    after: e.clientX > r.left + r.width / 2,
                  });
                }}
                onDragLeave={(e) => {
                  if (
                    !e.currentTarget.contains(e.relatedTarget as Node | null)
                  ) {
                    setDropAt(null);
                  }
                }}
                onDrop={(e) => {
                  const at = dropAt();
                  setDropAt(null);
                  const id = e.dataTransfer?.getData(TAB_DRAG_TYPE);
                  if (!id || !at || id === channel.id) return;
                  e.preventDefault();
                  const order = channelTabs().map((c) => c.id);
                  let to = order.indexOf(channel.id) + (at.after ? 1 : 0);
                  if (order.indexOf(id) < to) to -= 1;
                  moveChannelTab(id, to);
                }}
                onContextMenu={(e) =>
                  openContextMenu(
                    e,
                    !onScreen(channel.id) && canSplitPane()
                      ? [item("Open in split", () => splitPane(channel.id))]
                      : [],
                  )
                }
                onClick={() => show(channel.id)}
                onDblClick={() => keepChannel(channel.id)}
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
                <Show when={!active() && !inOtherPane() && unread() > 0}>
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
      <Show when={settings().splitView}>
        <button
          type="button"
          class="tabs__add"
          title={
            canSplitPane()
              ? "Open a channel next to this one"
              : "Four chats is the most side by side"
          }
          aria-label="Open a channel in a new pane"
          disabled={!canSplitPane()}
          onPointerEnter={() => void prefetchLive()}
          onClick={() => openPicker({ split: true })}
        >
          <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
            <rect
              x="0.75"
              y="0.75"
              width="12.5"
              height="10.5"
              rx="2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <path d="M7 1v10" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </Show>
      <button
        type="button"
        class="tabs__add"
        data-tour="add-channel"
        title="Open a channel (Ctrl+K)"
        aria-label="Open a channel"
        aria-busy={pickerLoading()}
        onPointerEnter={() => void prefetchLive()}
        onClick={() => openPicker()}
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
