// Gives everything inside it the chat session of one channel, held while
// the pane shows that channel and let go when it moves on.

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
  releaseSession,
} from "../lib/chatSession";

const ChatPane: ParentComponent<{ channel: Channel | null }> = (props) => {
  const session = createMemo(
    on(
      () => props.channel?.id,
      (id) => {
        const channel = untrack(() => props.channel);
        if (id === undefined || !channel) return undefined;
        const held = holdSession(channel);
        onCleanup(() => releaseSession(id));
        return held;
      },
    ),
  );
  return <SessionProvider value={session}>{props.children}</SessionProvider>;
};

export default ChatPane;
