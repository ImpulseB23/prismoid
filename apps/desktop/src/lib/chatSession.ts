// One chat session per channel a pane shows: that channel's messages,
// chatters, badges and emotes, filled from its stored history and bundle
// and then live from the chat router. Panes showing the same channel share one session, so its
// messages are added once however many panes draw them; it is dropped
// when the last pane lets go.

import { createContext, createSignal, useContext } from "solid-js";
import type { Channel } from "./twitchChannel";
import { attachFeed } from "./chatRouter";
import { createHistoryGate, loadHistory } from "./chatHistory";
import { bannedNotice } from "./chatAccess";
import {
  createClearPairing,
  modActionMessage,
  publicModerationMessage,
  userClearedNotice,
} from "./modActions";
import { currentEmoteBundle } from "./emoteBundle";
import {
  createChatStore,
  type ChatMessage,
  type ChatStore,
} from "../stores/chatStore";
import { createChatterStore, type ChatterStore } from "../stores/chatterStore";
import { settings } from "../stores/settingsStore";
import { currentUserId } from "../stores/authStore";
import { noteOwnMessage } from "../stores/ownIdentityStore";
import { ensureUserInfo } from "../stores/userInfoStore";
import { canModerateIn, noteModerator } from "../stores/roleStore";
import { recordModAction } from "../stores/modLogStore";
import {
  MODE_ACTIONS,
  createChatSettingsStore,
  type ChatSettingsStore,
} from "../stores/chatSettingsStore";
import {
  createBadgeStore,
  type BadgeStore,
  type EmoteBundle,
} from "../stores/badgeStore";
import {
  createEmoteStore,
  type EmoteBundleSets,
  type EmoteStore,
} from "../stores/emoteStore";

export interface ChatSession {
  readonly channelId: string;
  /** The channel the pane shows; null for a pane with none open. */
  readonly channel: Channel | null;
  readonly chat: ChatStore;
  readonly chatters: ChatterStore;
  readonly badges: BadgeStore;
  readonly emotes: EmoteStore;
  /** Room modes, loaded when a moderator opens the chat manager. */
  readonly roomModes: ChatSettingsStore;
  /** True while the stored tail is loading. */
  readonly historyLoading: () => boolean;
}

/** What a pane with no channel open reads: never written, always empty. */
export const idleSession: ChatSession = {
  channelId: "",
  channel: null,
  chat: createChatStore(),
  chatters: createChatterStore(),
  badges: createBadgeStore(),
  emotes: createEmoteStore(),
  roomModes: createChatSettingsStore(),
  historyLoading: () => false,
};

// Rows made here rather than by the host need their own ordering key.
// Starting far above any host sequence keeps them at the tail where they
// arrived, the same trick optimistic sends use.
let nextLocalSeq = Number.MAX_SAFE_INTEGER - 2 ** 40;

function openSession(channel: Channel): {
  session: ChatSession;
  close: () => void;
} {
  const chat = createChatStore();
  const chatters = createChatterStore();
  const badges = createBadgeStore();
  const emotes = createEmoteStore();
  const roomModes = createChatSettingsStore();
  const applyBundle = (bundle: EmoteBundle & EmoteBundleSets) => {
    badges.loadBundle(bundle);
    emotes.loadBundle(bundle);
  };
  const add = (batch: ChatMessage[]) => {
    chat.addMessages(batch);
    // Stored history can hold the user's newest message in a channel when
    // the live feed does not.
    const me = currentUserId();
    if (me) for (const m of batch) noteOwnMessage(m, me);
  };
  const history = createHistoryGate(add);
  history.begin(loadHistory(channel.id));
  const clears = createClearPairing();
  // Moderators get the full story from channel.moderate; everyone else
  // sees the effect Twitch reports to the whole channel.
  const publicRows = () =>
    settings().showModActions && !canModerateIn(channel.id);

  const detach = attachFeed({
    channel: () => channel.id,
    messages: (batch) => {
      const me = currentUserId();
      const ignored = settings().ignoredLogins;
      const accepted = batch.filter((m) => !ignored.includes(m.username));
      for (const m of accepted) {
        chatters.record(
          m.platform_user_id,
          m.username,
          m.display_name,
          m.arrival_time,
        );
        // Our own message wearing the moderator badge is proof of the
        // role here, including one granted after the Helix list was
        // fetched.
        if (m.is_mod && me && m.platform_user_id === me) {
          noteModerator(channel.id);
        }
      }
      ensureUserInfo(
        accepted
          .filter((m) => m.platform === "Twitch")
          .map((m) => m.platform_user_id),
      );
      if (!history.offer(accepted)) chat.addMessages(accepted);
    },
    event: (e) => {
      switch (e.kind) {
        case "message_deleted": {
          const target = chat.findById(e.message_id);
          chat.markDeleted(e.message_id);
          if (publicRows()) {
            chat.addMessages([
              publicModerationMessage(e, nextLocalSeq++, target),
            ]);
          }
          break;
        }
        case "user_cleared":
          chat.markUserCleared(e.target_user_id);
          if (publicRows()) {
            const clear = clears.take(e.target_user_id);
            const row = publicModerationMessage(
              e,
              nextLocalSeq++,
              undefined,
              clear,
            );
            chat.addMessages([row]);
            if (!clear) clears.wait(e.target_user_id, row.id);
          }
          break;
        case "chat_cleared":
          chat.markAllDeleted();
          if (publicRows()) {
            chat.addMessages([publicModerationMessage(e, nextLocalSeq++)]);
          }
          break;
        case "chat_settings":
          roomModes.receive(e);
          break;
        case "mod_action":
          recordModAction(e);
          // Only moderators get these, and they may have the modes open.
          if (MODE_ACTIONS.has(e.action)) void roomModes.load(channel.id);
          if (settings().showModActions) {
            chat.addMessages([modActionMessage(e, nextLocalSeq++)]);
          }
          break;
      }
    },
    banned: () => chat.addMessages([bannedNotice(channel, nextLocalSeq++)]),
    userClear: (clear) => {
      if (!publicRows()) return;
      const rowId = clears.arrive(clear);
      if (rowId === undefined) return;
      chat.update(rowId, (row) => ({
        ...row,
        notice: userClearedNotice(
          row.display_name || row.username || "A user",
          clear,
        ),
      }));
    },
    bundle: applyBundle,
  });

  // The host keeps the bundle of every joined channel.
  currentEmoteBundle(channel.id)
    .then((bundle) => {
      if (bundle) applyBundle(bundle);
    })
    .catch((err: unknown) =>
      console.error("failed to load emote bundle:", err),
    );

  return {
    session: {
      channelId: channel.id,
      channel,
      chat,
      chatters,
      badges,
      emotes,
      roomModes,
      historyLoading: history.loading,
    },
    close: () => {
      detach();
      history.cancel();
    },
  };
}

interface Held {
  session: ChatSession;
  close: () => void;
  holders: number;
}

const [held, setHeld] = createSignal<ReadonlyMap<string, Held>>(new Map());

/** Opens the channel's session, or shares the one already open. */
export function holdSession(channel: Channel): ChatSession {
  const current = held().get(channel.id);
  if (current) {
    current.holders++;
    return current.session;
  }
  const opened = { ...openSession(channel), holders: 1 };
  setHeld((m) => new Map(m).set(channel.id, opened));
  return opened.session;
}

/** Lets go of a session from `holdSession`; the last release closes it. */
export function releaseSession(channelId: string): void {
  const current = held().get(channelId);
  if (!current || --current.holders > 0) return;
  current.close();
  setHeld((m) => {
    const next = new Map(m);
    next.delete(channelId);
    return next;
  });
}

/** The open session for a channel, for surfaces outside any pane. */
export function sessionFor(
  channelId: string | undefined,
): ChatSession | undefined {
  return channelId === undefined ? undefined : held().get(channelId)?.session;
}

const SessionContext = createContext<() => ChatSession>(() => idleSession);

export const SessionProvider = SessionContext.Provider;

/** The session of the pane this component is in. */
export function useSession(): () => ChatSession {
  return useContext(SessionContext);
}
