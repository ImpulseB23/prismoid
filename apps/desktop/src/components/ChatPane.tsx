// One chat pane: the session of the channel it shows, held while it shows
// it and let go when it moves on, plus the composer, thread panel and
// notice line of its own. Clicking or typing anywhere in it focuses it.

import {
  createMemo,
  on,
  onCleanup,
  onMount,
  untrack,
  type ParentComponent,
} from "solid-js";
import type { Channel } from "../lib/twitchChannel";
import {
  SessionProvider,
  holdSession,
  idleSession,
  releaseSession,
} from "../lib/chatSession";
import {
  PaneProvider,
  blurPane,
  focusPane,
  focusedPane,
  type Pane,
} from "../lib/pane";
import { createComposer } from "../stores/composerStore";
import { createThreadPanel } from "../stores/threadStore";
import { createNoticeLine } from "../stores/noticeStore";

const ChatPane: ParentComponent<{ channel: Channel | null }> = (props) => {
  const session = createMemo(
    on(
      () => props.channel?.id,
      (id) => {
        const channel = untrack(() => props.channel);
        if (id === undefined || !channel) return idleSession;
        const held = holdSession(channel);
        onCleanup(() => releaseSession(id));
        return held;
      },
    ),
  );
  const pane: Pane = {
    session,
    composer: createComposer(),
    thread: createThreadPanel(),
    notice: createNoticeLine(),
  };
  onMount(() => {
    if (!focusedPane()) focusPane(pane);
  });
  onCleanup(() => blurPane(pane));

  return (
    <SessionProvider value={session}>
      <PaneProvider value={pane}>
        <div
          class="chat-pane"
          onPointerDown={() => focusPane(pane)}
          onFocusIn={() => focusPane(pane)}
        >
          {props.children}
        </div>
      </PaneProvider>
    </SessionProvider>
  );
};

export default ChatPane;
