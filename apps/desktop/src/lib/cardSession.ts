// What a user card window loads for itself. It shares nothing in memory
// with the main window, so it fetches the session, roles and paints once,
// and for each person it shows: their stored messages, the channel's
// badges, the mod log from the main window, and their new messages.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CardUser } from "../components/UserCard";
import { getAuthStatus } from "./twitchAuth";
import { currentEmoteBundle } from "./emoteBundle";
import { followModLog } from "./cardBridge";
import { loadUserHistory } from "./userCardWindow";
import { createHistoryGate } from "./chatHistory";
import { setAuthStatus } from "../stores/authStore";
import type { BadgeStore } from "../stores/badgeStore";
import type { ChatMessage, ChatStore } from "../stores/chatStore";
import { clearModLog, recordModAction } from "../stores/modLogStore";
import { syncPaints } from "../stores/paintStore";
import { loadModeratedChannels } from "../stores/roleStore";
import { followSettingsElsewhere } from "../stores/settingsStore";

/** Stored messages loaded when a card opens. */
export const CARD_HISTORY = 50;

const report = (what: string) => (err: unknown) => console.error(what, err);

/** Once per card window; returns the stop function. */
export async function startCardSession(): Promise<() => void> {
  try {
    setAuthStatus(await getAuthStatus());
  } catch {
    setAuthStatus({ state: "logged_out" });
  }
  void loadModeratedChannels();
  const stops = await Promise.all([syncPaints(), followSettingsElsewhere()]);
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * For each person the card shows, into a store of their own; returns the
 * stop function.
 */
export async function showCardUser(
  user: CardUser,
  chat: ChatStore,
  badges: BadgeStore,
): Promise<() => void> {
  const { channel_id: channel, platform_user_id: id } = user;
  const theirs = (m: ChatMessage) =>
    m.channel_id === channel && m.platform_user_id === id;

  clearModLog();
  const offs: UnlistenFn[] = [];
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const off of offs) off();
  };

  // The same gate the feed uses: live messages that land while history
  // loads wait for it, and a stored copy of one of them is dropped.
  const gate = createHistoryGate(chat.addMessages);
  offs.push(gate.cancel);
  gate.begin(loadUserHistory(channel, id, CARD_HISTORY));
  offs.push(
    await listen<ChatMessage[]>("chat_messages", (e) => {
      const batch = e.payload.filter(theirs);
      if (!stopped && batch.length > 0 && !gate.offer(batch)) {
        chat.addMessages(batch);
      }
    }),
  );
  const bundle = await currentEmoteBundle(channel).catch((err: unknown) => {
    report("card emotes")(err);
    return null;
  });
  if (stopped) return stop;
  if (bundle) badges.loadBundle(bundle);
  offs.push(
    await followModLog(id, (actions) => {
      if (stopped) return;
      clearModLog();
      // The main window sends newest first; recording oldest first keeps
      // that order here.
      for (const a of [...actions].reverse()) recordModAction(a);
    }),
  );
  return stop;
}
