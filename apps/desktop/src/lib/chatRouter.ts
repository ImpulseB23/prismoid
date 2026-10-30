// One listener per host chat event for the whole window. What concerns
// the app rather than one feed happens here exactly once: pulse, unread
// counts, mentions and their alert, your own look, AutoMod holds, polls,
// predictions, ad breaks, bans and first-message marks. Each mounted feed
// attaches for its channel and gets only that channel's rows, so a window
// with several feeds neither counts nor alerts twice.

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { ChatMessage } from "../stores/chatStore";
import type { ChatEvent } from "./chatEvents";
import type { ChatBanned } from "./chatAccess";
import type { EmoteBundle } from "../stores/badgeStore";
import type { EmoteBundleSets } from "../stores/emoteStore";
import type { FirstMessage } from "../stores/firstMessageStore";
import { markFirstMessage } from "../stores/firstMessageStore";
import { markChannelBanned, noteUnread } from "../stores/channelStore";
import { settings } from "../stores/settingsStore";
import { isMentionFor, recordMention } from "../stores/mentionsStore";
import { noteOwnMessage } from "../stores/ownIdentityStore";
import { currentUserId } from "../stores/authStore";
import { recordPulse } from "../stores/pulseStore";
import { recordHeldMessage, resolveHeldMessage } from "../stores/automodStore";
import {
  applyPollUpdate,
  applyPredictionUpdate,
} from "../stores/streamManagerStore";
import { applyAdBreak } from "../stores/adStore";
import { syncPaints } from "../stores/paintStore";
import { createMentionAlert, playChime } from "./mentionAlert";
import { isForChannel } from "./twitchChannel";

type Bundle = EmoteBundle & EmoteBundleSets;

/** A feed showing one channel; `channel` is undefined before one is open. */
export interface FeedSink {
  channel: () => string | undefined;
  messages: (batch: ChatMessage[]) => void;
  /** Deletions, clears and moderator actions in the feed's channel. */
  event: (e: ChatEvent) => void;
  banned: (ban: ChatBanned) => void;
  bundle: (bundle: Bundle) => void;
}

const sinks = new Set<FeedSink>();

export function attachFeed(sink: FeedSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function shown(channelId: string): boolean {
  for (const s of sinks) if (s.channel() === channelId) return true;
  return false;
}

function routeMessages(batch: ChatMessage[], login: string): void {
  const me = currentUserId();
  const { highlightPhrases, ignoredLogins, mentionAlerts } = settings();
  // Every channel's pulse counts all of its chat, ignored chatters
  // included; channels no feed shows only move their unread count, since
  // the host's log holds their messages until one does.
  for (const m of batch) {
    if (m.platform === "Twitch" && !m.notice && m.platform_user_id) {
      recordPulse(m.channel_id, m.platform_user_id, m.arrival_time);
    }
    if (me) noteOwnMessage(m, me);
    if (m.platform === "Twitch" && !m.notice && !shown(m.channel_id)) {
      noteUnread(m.channel_id);
    }
    if (isMentionFor(m, login, highlightPhrases, ignoredLogins)) {
      recordMention(m);
      if (mentionAlerts) mentionAlert.notify();
    }
  }
  for (const s of sinks) {
    const id = s.channel();
    const theirs = batch.filter((m) => isForChannel(m, id));
    if (theirs.length > 0) s.messages(theirs);
  }
}

function routeEvents(events: ChatEvent[]): void {
  for (const e of events) {
    switch (e.kind) {
      // The AutoMod queue keeps every moderated channel, so a hold in one
      // nobody is looking at waits there.
      case "automod_held":
        recordHeldMessage(e);
        continue;
      case "automod_resolved":
        resolveHeldMessage(e);
        continue;
      // Only the user's own channel sends these, and the stream manager
      // keeps them whichever channel is showing.
      case "poll_update":
        applyPollUpdate(e);
        continue;
      case "prediction_update":
        applyPredictionUpdate(e);
        continue;
      case "ad_break":
        applyAdBreak(e);
        continue;
    }
    for (const s of sinks) {
      const id = s.channel();
      if (id === undefined || e.channel_id === id) s.event(e);
    }
  }
}

const mentionAlert = createMentionAlert({
  focused: () => document.hasFocus(),
  chimeWhenFocused: () => settings().chimeAlways,
  chime: () => playChime(settings().chimeVolume),
  flash: () =>
    getCurrentWindow().requestUserAttention(UserAttentionType.Informational),
});

/** Once per window; `login` is the signed-in user, for mentions. */
export async function startChatRouter(
  login: () => string,
): Promise<() => void> {
  // Each registers on its own, so one that fails leaves the rest working.
  const registered = await Promise.allSettled([
    listen<ChatMessage[]>("chat_messages", (e) =>
      routeMessages(e.payload, login()),
    ),
    listen<ChatEvent[]>("chat_events", (e) => routeEvents(e.payload)),
    listen<ChatBanned>("chat_banned", (e) => {
      markChannelBanned(e.payload.broadcaster_id);
      for (const s of sinks) {
        if (s.channel() === e.payload.broadcaster_id) s.banned(e.payload);
      }
    }),
    listen<FirstMessage>("first_message", (e) =>
      markFirstMessage(e.payload.message_id),
    ),
    // The host emits a bundle per channel join; feeds showing another
    // channel fetch theirs when they switch to it.
    listen<Bundle>("emote_bundle", (e) => {
      for (const s of sinks) {
        if (s.channel() === e.payload.broadcaster_id) s.bundle(e.payload);
      }
    }),
    syncPaints(),
  ]);
  const stops: (() => void)[] = [];
  for (const r of registered) {
    if (r.status === "fulfilled") stops.push(r.value);
    else console.error("chat router listen", r.reason);
  }
  return () => {
    for (const stop of stops) stop();
  };
}
