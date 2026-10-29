// Chat panes side by side. The focused pane's channel is the active tab,
// so tabs, the stream bar and the header follow it; picking a tab shows it
// in the focused pane, or focuses the pane already showing it. A tab
// dragged onto a pane shows there, and onto the right edge opens a pane.

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
  channelStatus,
  channelTabs,
  focusChannel,
} from "../stores/channelStore";
import {
  closePane,
  draggedTab,
  focusedPaneChannel,
  focusedPaneId,
  keepPaneChannels,
  panes,
  showInFocusedPane,
  showInPane,
  splitPane,
  canSplitPane,
  togglePaneVideo,
  setPaneVideo,
  TAB_DRAG_TYPE,
} from "../stores/layoutStore";
import ChatPane from "./ChatPane";
import ChatFeed from "./ChatFeed";
import CommandCenter from "./CommandCenter";
import MessageInput from "./MessageInput";
import StreamVideo from "./StreamVideo";
import {
  followVideoWindows,
  isPoppedOut,
  openVideoWindow,
} from "../lib/videoWindow";

const report = (what: string) => (err: unknown) => console.error(what, err);

const SplitView: Component<{ login: string }> = (props) => {
  // A tab picked anywhere (strip, picker, Ctrl+Tab) lands in the focused
  // pane; focusing another pane makes its channel the active tab.
  createEffect(
    on(
      () => activeChannel()?.id,
      (id) => {
        if (id !== undefined) showInFocusedPane(id);
      },
    ),
  );
  createEffect(
    on(focusedPaneChannel, (id) => {
      if (id !== null && id !== activeChannel()?.id) {
        void focusChannel(id).catch(report("focus pane channel"));
      }
    }),
  );
  // A pop-out asking to come back shows in the corner of its channel's
  // pane, or of the focused pane when no pane has that channel.
  onMount(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void followVideoWindows((login) => {
      const channel = channelTabs().find((c) => c.login === login);
      if (!channel) return;
      showInFocusedPane(channel.id);
      const pane = panes().find((p) => p.channelId === channel.id);
      if (pane) setPaneVideo(pane.id, true);
    })
      .then((fn) => {
        if (disposed) fn();
        else stop = fn;
      })
      .catch(report("follow video windows"));
    onCleanup(() => {
      disposed = true;
      stop?.();
    });
  });

  // Once the saved tabs are back, panes of channels that did not come
  // back go. Before that the tabs are still arriving one by one.
  createEffect(() => {
    if (channelStatus() !== "ready") return;
    keepPaneChannels(new Set(channelTabs().map((c) => c.id)));
  });

  const channelOf = (id: string | null) =>
    id === null ? null : (channelTabs().find((c) => c.id === id) ?? null);
  const many = () => panes().length > 1;

  return (
    <div class="split" classList={{ "split--many": many() }}>
      <For each={panes().map((p) => p.id)}>
        {(slotId) => {
          const slot = () => panes().find((p) => p.id === slotId)!;
          const channel = () => channelOf(slot().channelId);
          const [over, setOver] = createSignal(false);
          return (
            <ChatPane
              slotId={slotId}
              channel={channel()}
              focused={many() && focusedPaneId() === slotId}
            >
              <div
                class="split__drop"
                classList={{
                  "split__drop--armed": draggedTab() !== null,
                  "split__drop--over": over(),
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  setOver(false);
                  const id = e.dataTransfer?.getData(TAB_DRAG_TYPE);
                  if (!id) return;
                  e.preventDefault();
                  showInPane(slotId, id);
                }}
              />
              <Show when={many()}>
                <PaneHeader
                  name={channel()?.display_name ?? "No channel"}
                  picture={channel()?.profile_image_url}
                  onClose={() => closePane(slotId)}
                />
              </Show>
              <div class="chat-area">
                <ChatFeed login={props.login} />
                <Show
                  when={
                    slot().video && !isPoppedOut(channel()?.login ?? "")
                      ? channel()
                      : null
                  }
                >
                  {(c) => (
                    <StreamVideo
                      login={c().login}
                      name={c().display_name}
                      onClose={() => togglePaneVideo(slotId)}
                      // The window takes over, so the stream never plays
                      // twice.
                      onPopOut={() => {
                        // Read before closing the preview unmounts it.
                        const { login, display_name } = c();
                        togglePaneVideo(slotId);
                        openVideoWindow(
                          login,
                          `${display_name}'s stream`,
                        ).catch(report("open video window"));
                      }}
                    />
                  )}
                </Show>
                <CommandCenter />
              </div>
              <MessageInput login={props.login} />
            </ChatPane>
          );
        }}
      </For>
      <Show when={draggedTab() !== null && canSplitPane()}>
        <EdgeDrop />
      </Show>
    </div>
  );
};

const EdgeDrop: Component = () => {
  const [over, setOver] = createSignal(false);
  return (
    <div
      class="split__edge"
      classList={{ "split__edge--over": over() }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes(TAB_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer?.getData(TAB_DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        splitPane(id, panes().at(-1)!.id);
      }}
    >
      New pane
    </div>
  );
};

const PaneHeader: Component<{
  name: string;
  picture: string | undefined;
  onClose: () => void;
}> = (props) => (
  <div class="pane-head">
    <Show when={props.picture} fallback={<span class="pane-head__avatar" />}>
      {(url) => <img class="pane-head__avatar" src={url()} alt="" />}
    </Show>
    <span class="pane-head__name">{props.name}</span>
    <button
      type="button"
      class="icon-btn pane-head__close"
      aria-label={`Close ${props.name}'s pane`}
      title="Close pane"
      onClick={props.onClose}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
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

export default SplitView;
