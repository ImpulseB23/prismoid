// One chat pane: the session of the channel it shows, held while it shows
// it and let go when it moves on, plus the composer, thread panel and
// notice line of its own. Clicking or typing anywhere in it focuses it.

import {
  createMemo,
  on,
  onCleanup,
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
import { PaneProvider, registerPane, type Pane } from "../lib/pane";
import { focusPaneSlot } from "../stores/layoutStore";
import { createComposer } from "../stores/composerStore";
import { createThreadPanel } from "../stores/threadStore";
import { createNoticeLine } from "../stores/noticeStore";

export interface ChatPaneProps {
  /** The layout slot this pane draws. */
  slotId: string;
  channel: Channel | null;
  focused: boolean;
}

const ChatPane: ParentComponent<ChatPaneProps> = (props) => {
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
  onCleanup(registerPane(props.slotId, pane));
  const focus = () => focusPaneSlot(props.slotId);

  return (
    <SessionProvider value={session}>
      <PaneProvider value={pane}>
        <div
          class="chat-pane"
          classList={{ "chat-pane--focused": props.focused }}
          onPointerDown={focus}
          onFocusIn={focus}
        >
          {props.children}
        </div>
      </PaneProvider>
    </SessionProvider>
  );
};

export default ChatPane;
