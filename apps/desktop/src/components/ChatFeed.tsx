// Virtualized chat renderer. Uses Pretext for exact pixel-perfect message
// heights (no DOM reflow), binary-searches the visible range, and keeps
// the mounted DOM bounded to the viewport window + overscan. ADR 21 +
// docs/frontend.md: one viewport signal per frame, message buffer lives
// outside Solid reactivity.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import {
  addMessages,
  clearMessages,
  confirmPendingId,
  failPending,
  findMessageById,
  getMessage,
  markAllMessagesDeleted,
  markMessageDeleted,
  markUserMessagesCleared,
  messageRevision,
  retryPending,
  viewport,
  type ChatMessage,
} from "../stores/chatStore";
import type { ChatEvent } from "../lib/chatEvents";
import {
  activeChannel,
  channelBanned,
  channelStatus,
  markChannelBanned,
  noteUnread,
  rejoinChannel,
} from "../stores/channelStore";
import { isIgnored, setIgnored, settings } from "../stores/settingsStore";
import { isHighlighted, isSpotlit } from "../lib/highlight";
import { createMentionAlert, playChime } from "../lib/mentionAlert";
import { recordMention } from "../stores/mentionsStore";
import { openThread } from "../stores/threadStore";
import Thread from "./Thread";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  banUser,
  deleteMessage,
  sendMessage,
  timeoutUser,
  unbanUser,
  type SendMessageError,
} from "../lib/twitchAuth";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatSeconds } from "../lib/slashCommands";
import { messageMenuItems } from "../lib/messageMenu";
import { openContextMenu } from "../stores/contextMenuStore";
import { notice, notify } from "../stores/noticeStore";
import { formatSendError, toSendError } from "../lib/messageInput";
import { isForChannel } from "../lib/twitchChannel";
import { createHistoryGate, loadHistory } from "../lib/chatHistory";
import { currentEmoteBundle } from "../lib/emoteBundle";
import {
  loadBadgeBundle,
  resolveBadge,
  badgeRevision,
  type EmoteBundle,
} from "../stores/badgeStore";
import { loadEmoteBundle, type EmoteBundleSets } from "../stores/emoteStore";
import { clearChatters, recordChatter } from "../stores/chatterStore";
import { canModerate, noteModerator } from "../stores/roleStore";
import { clearModLog, recordModAction } from "../stores/modLogStore";
import {
  MODE_ACTIONS,
  clearChatSettings,
  loadChatSettings,
} from "../stores/chatSettingsStore";
import { modActionMessage, publicModerationMessage } from "../lib/modActions";
import {
  BANNED_HINT,
  bannedNotice,
  bannedText,
  type ChatBanned,
} from "../lib/chatAccess";
import {
  ensureUserInfo,
  isNewAccount,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";
import { requestMention, requestReply } from "../stores/composerStore";
import {
  BADGE_GAP_PX,
  MESSAGE_FONT_FAMILY,
  MEASURED_FONTS,
  MESSAGE_PADDING_X,
  MESSAGE_PADDING_Y,
  measureMessageHeight,
  prepareMessage,
  textMetrics,
  type TextMetrics,
  type PreparedMessage,
} from "../lib/messageLayout";
import { normalizeUserColor } from "../lib/messageStyle";
import { isLight, logo } from "../stores/themeStore";
import MessagePieces from "./MessagePieces";
import UserCard, { type CardUser } from "./UserCard";
import EmoteCard from "./EmoteCard";
import ContextMenu from "./ContextMenu";

const OVERSCAN = 6;
const STICK_THRESHOLD = 40;

// Moderator action rows are made here, not by the host, so they need their
// own ordering key. Starting far above any host sequence keeps them at the
// tail where they arrived, the same trick optimistic sends use.
let nextModActionSeq = Number.MAX_SAFE_INTEGER - 2 ** 40;

interface PositionedMessage {
  monoIndex: number;
  msg: ChatMessage;
  prepared: PreparedMessage;
  top: number;
  height: number;
}

interface CachedEntry {
  prepared: PreparedMessage;
  height: number;
  measuredWidth: number;
}

/** Index of the first message whose bottom edge is below `y`. */
function firstBelow(messages: PositionedMessage[], y: number): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (messages[mid]!.top + messages[mid]!.height > y) high = mid;
    else low = mid + 1;
  }
  return low;
}

function findByMono(
  messages: PositionedMessage[],
  mono: number,
): PositionedMessage | undefined {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const m = messages[mid]!.monoIndex;
    if (m === mono) return messages[mid];
    if (m < mono) low = mid + 1;
    else high = mid;
  }
  return undefined;
}

export interface ChatFeedProps {
  /** Login of the signed-in user, for mention highlighting. */
  login: string;
}

const ChatFeed: Component<ChatFeedProps> = (props) => {
  const mentionAlert = createMentionAlert({
    focused: () => document.hasFocus(),
    chime: playChime,
    flash: () =>
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational),
  });
  let containerRef: HTMLDivElement | undefined;
  const entryCache = new Map<number, CachedEntry>();
  let lastBadgeRev = 0;
  let lastMessageRev = 0;
  let lastTimestamps: boolean | undefined;
  let lastMetrics: TextMetrics | undefined;

  const [width, setWidth] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [stickToBottom, setStickToBottom] = createSignal(true);
  const [fontsLoaded, setFontsLoaded] = createSignal(false);
  const [cardUser, setCardUser] = createSignal<CardUser | null>(null);
  // Monotonic index of the newest message the user had in view when they
  // scrolled away from the bottom; drives the "N new" count on the pill.
  const [readUpTo, setReadUpTo] = createSignal<number | null>(null);

  // While the user reads backlog, hold the message under the top edge in
  // place. Evictions shift every later message up by the evicted height,
  // and without this the text would crawl out from under the cursor.
  let anchor: { mono: number; offset: number } | null = null;

  let scrollRafPending = false;

  const anchorAt = (top: number) => {
    const { messages } = layout();
    const i = firstBelow(messages, top);
    const m = messages[i];
    return m ? { mono: m.monoIndex, offset: top - m.top } : null;
  };

  const handleScroll = () => {
    if (!containerRef) return;
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      if (!containerRef) return;
      const top = containerRef.scrollTop;
      const clientH = containerRef.clientHeight;
      const totalH = containerRef.scrollHeight;
      setScrollTop(top);
      const atBottom = totalH - top - clientH <= STICK_THRESHOLD;
      if (atBottom !== stickToBottom()) {
        setStickToBottom(atBottom);
        const v = viewport();
        setReadUpTo(atBottom ? null : v.start + v.count);
      }
      anchor = atBottom ? null : anchorAt(top);
    });
  };

  const jumpToLatest = () => {
    if (!containerRef) return;
    containerRef.scrollTop = containerRef.scrollHeight;
    anchor = null;
    setStickToBottom(true);
    setReadUpTo(null);
  };

  const history = createHistoryGate(addMessages);
  onCleanup(() => history.cancel());

  // A channel switch empties the view. Indices stay monotonic so the
  // entry cache cannot serve stale layouts, but nothing in it is
  // reachable any more, so drop it too. The stored tail then fills the
  // empty view; a remount (hot reload) keeps the store, so a view that
  // already has rows does not ask again.
  createEffect(
    on(
      () => activeChannel()?.id,
      (id, prev) => {
        if (id === prev) return;
        if (prev !== undefined) {
          clearMessages();
          clearChatters();
          clearModLog();
          clearChatSettings();
          entryCache.clear();
          anchor = null;
          setStickToBottom(true);
          setReadUpTo(null);
          setCardUser(null);
        }
        if (id !== undefined && viewport().count === 0) {
          history.begin(loadHistory(id));
        }
        // Each tab has its own emotes and badges; the host keeps the bundle
        // of every joined channel.
        if (id !== undefined) {
          currentEmoteBundle(id)
            .then((bundle) => {
              if (bundle && activeChannel()?.id === id) applyBundle(bundle);
            })
            .catch((err) => console.error("failed to load emote bundle:", err));
        }
      },
    ),
  );

  const applyBundle = (bundle: EmoteBundle & EmoteBundleSets) => {
    loadBadgeBundle(bundle);
    loadEmoteBundle(bundle);
  };

  const layout = createMemo<{
    messages: PositionedMessage[];
    byMono: Map<number, PositionedMessage>;
    totalHeight: number;
  }>(() => {
    const v = viewport();
    const w = width();
    // Read the badge revision so bundle reloads invalidate the prepared
    // cache and trigger a full re-measure.
    const rev = badgeRevision();
    // Read the message-mutation revision so reconciled or failed
    // pending entries re-render with their new content.
    const msgRev = messageRevision();
    const timestamps = settings().showTimestamps;
    const metrics = textMetrics(settings().textSize);
    if (!fontsLoaded() || w <= 0 || v.count === 0) {
      return { messages: [], byMono: new Map(), totalHeight: 0 };
    }

    const liveStart = v.start;
    const liveEnd = v.start + v.count;

    for (const key of entryCache.keys()) {
      if (key < liveStart) entryCache.delete(key);
    }
    if (rev !== lastBadgeRev) {
      entryCache.clear();
      lastBadgeRev = rev;
    }
    if (msgRev !== lastMessageRev) {
      entryCache.clear();
      lastMessageRev = msgRev;
    }
    if (timestamps !== lastTimestamps) {
      entryCache.clear();
      lastTimestamps = timestamps;
    }
    if (metrics !== lastMetrics) {
      entryCache.clear();
      lastMetrics = metrics;
    }

    const messages: PositionedMessage[] = new Array(v.count);
    const byMono = new Map<number, PositionedMessage>();
    let y = 0;
    let writeIdx = 0;
    for (let mono = liveStart; mono < liveEnd; mono++) {
      const msg = getMessage(mono);
      if (!msg) continue;
      let entry = entryCache.get(mono);
      if (entry === undefined || entry.measuredWidth !== w) {
        const prepared =
          entry !== undefined
            ? entry.prepared
            : prepareMessage(msg, resolveBadge, { timestamps, metrics });
        const height = measureMessageHeight(prepared, w);
        entry = { prepared, height, measuredWidth: w };
        entryCache.set(mono, entry);
      }
      const positioned: PositionedMessage = {
        monoIndex: mono,
        msg,
        prepared: entry.prepared,
        top: y,
        height: entry.height,
      };
      messages[writeIdx++] = positioned;
      byMono.set(mono, positioned);
      y += entry.height;
    }
    messages.length = writeIdx;
    return { messages, byMono, totalHeight: y };
  });

  const visibleRange = createMemo<{ start: number; end: number }>(() => {
    const { messages } = layout();
    const top = scrollTop();
    const vh = viewportHeight();
    if (messages.length === 0 || vh === 0) return { start: 0, end: 0 };

    const minY = Math.max(0, top);
    const maxY = top + vh;

    const start = Math.max(0, firstBelow(messages, minY) - OVERSCAN);

    let low = start;
    let high = messages.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (messages[mid]!.top >= maxY) high = mid;
      else low = mid + 1;
    }
    const end = Math.min(messages.length, low + OVERSCAN);
    return { start, end };
  });

  // Message indices in view. Numbers compare by value, so <For> keeps the
  // DOM node of every message that stays on screen across layouts instead
  // of rebuilding rows on each batch.
  const visibleMonos = createMemo<number[]>(() => {
    const { messages } = layout();
    const { start, end } = visibleRange();
    const monos = new Array<number>(end - start);
    for (let i = start; i < end; i++) monos[i - start] = messages[i]!.monoIndex;
    return monos;
  });

  const unseenCount = createMemo(() => {
    const upTo = readUpTo();
    if (upTo === null) return 0;
    const v = viewport();
    return Math.max(0, v.start + v.count - upTo);
  });

  createEffect(() => {
    const { messages, totalHeight } = layout();
    if (!containerRef) return;
    const vh = viewportHeight();
    if (vh === 0) return;

    if (stickToBottom()) {
      const target = Math.max(0, totalHeight - vh);
      if (Math.abs(containerRef.scrollTop - target) > 0.5) {
        containerRef.scrollTop = target;
      }
      return;
    }

    if (!anchor) return;
    const held = findByMono(messages, anchor.mono);
    if (!held) {
      // The anchored message was evicted; there is nothing to hold onto.
      anchor = anchorAt(containerRef.scrollTop);
      return;
    }
    const target = held.top + anchor.offset;
    if (Math.abs(containerRef.scrollTop - target) > 0.5) {
      containerRef.scrollTop = target;
      setScrollTop(target);
    }
  });

  onMount(() => {
    if (!containerRef) return;

    const ro = new ResizeObserver(() => {
      if (!containerRef) return;
      setWidth(containerRef.clientWidth);
      setViewportHeight(containerRef.clientHeight);
    });
    ro.observe(containerRef);
    setWidth(containerRef.clientWidth);
    setViewportHeight(containerRef.clientHeight);

    // Pretext uses canvas measureText; heights are only trustworthy once
    // the measured faces are decoded. Load each explicitly: `fonts.ready`
    // alone would not cover faces nothing in the DOM has used yet (the
    // mono timestamp face before the first message). Fall back to
    // immediate readiness where FontFaceSet is missing, and on rejection
    // so the UI never gets stuck waiting on a promise that never settles.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts && typeof fonts.load === "function") {
      Promise.all(MEASURED_FONTS.map((f) => fonts.load(f)))
        .then(() => setFontsLoaded(true))
        .catch(() => setFontsLoaded(true));
    } else {
      setFontsLoaded(true);
    }

    // listen() is async, so a disposal (hot reload, view torn down) can
    // land before a registration resolves. A handle that arrives after
    // that point is released at once; otherwise every later batch would
    // render once per leaked listener.
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const retain = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    listen<ChatMessage[]>("chat_messages", (event) => {
      const id = activeChannel()?.id;
      const ignored = settings().ignoredLogins;
      const accepted = event.payload.filter(
        (m) => isForChannel(m, id) && !ignored.includes(m.username),
      );
      // Messages for other tabs only move their unread count; the host's
      // log holds them until that tab is shown.
      for (const m of event.payload) {
        if (m.platform === "Twitch" && !isForChannel(m, id) && !m.notice) {
          noteUnread(m.channel_id);
        }
        if (
          !m.notice &&
          m.username !== props.login &&
          !ignored.includes(m.username) &&
          isHighlighted(
            m.message_text,
            props.login,
            settings().highlightPhrases,
          )
        ) {
          recordMention(m);
          if (settings().mentionAlerts) mentionAlert.notify();
        }
      }
      for (const m of accepted) {
        recordChatter(
          m.platform_user_id,
          m.username,
          m.display_name,
          m.arrival_time,
        );
        // Our own message wearing the moderator badge is proof of the role
        // here, including one granted after the Helix list was fetched.
        if (m.is_mod && m.username === props.login && id !== undefined) {
          noteModerator(id);
        }
      }
      ensureUserInfo(
        accepted
          .filter((m) => m.platform === "Twitch")
          .map((m) => m.platform_user_id),
      );
      if (!history.offer(accepted)) addMessages(accepted);
    })
      .then(retain)
      .catch((err) =>
        console.error("failed to listen for chat messages:", err),
      );

    listen<ChatEvent[]>("chat_events", (event) => {
      const id = activeChannel()?.id;
      // Moderators get the full story from channel.moderate; everyone
      // else sees the effect Twitch reports to the whole channel.
      const publicRows = settings().showModActions && !canModerate();
      for (const e of event.payload) {
        if (id !== undefined && e.channel_id !== id) continue;
        switch (e.kind) {
          case "message_deleted": {
            const target = findMessageById(e.message_id);
            markMessageDeleted(e.message_id);
            if (publicRows) {
              addMessages([
                publicModerationMessage(e, nextModActionSeq++, target),
              ]);
            }
            break;
          }
          case "user_cleared":
            markUserMessagesCleared(e.target_user_id);
            if (publicRows) {
              addMessages([publicModerationMessage(e, nextModActionSeq++)]);
            }
            break;
          case "chat_cleared":
            markAllMessagesDeleted();
            if (publicRows) {
              addMessages([publicModerationMessage(e, nextModActionSeq++)]);
            }
            break;
          case "mod_action":
            recordModAction(e);
            if (MODE_ACTIONS.has(e.action) && id !== undefined) {
              void loadChatSettings(id);
            }
            if (settings().showModActions) {
              addMessages([modActionMessage(e, nextModActionSeq++)]);
            }
            break;
        }
      }
    })
      .then(retain)
      .catch((err) => console.error("failed to listen for chat events:", err));

    listen<ChatBanned>("chat_banned", (event) => {
      markChannelBanned(event.payload.broadcaster_id);
      const channel = activeChannel();
      if (!channel || event.payload.broadcaster_id !== channel.id) return;
      addMessages([bannedNotice(channel, nextModActionSeq++)]);
    })
      .then(retain)
      .catch((err) => console.error("failed to listen for chat bans:", err));

    // The host emits a bundle per channel join; only the tab on screen
    // applies it, the rest are fetched when their tab is shown.
    listen<EmoteBundle & EmoteBundleSets>("emote_bundle", (event) => {
      if (event.payload.broadcaster_id === activeChannel()?.id) {
        applyBundle(event.payload);
      }
    })
      .then(retain)
      .catch((err) =>
        console.error("failed to listen for emote bundles:", err),
      );

    onCleanup(() => {
      ro.disconnect();
      disposed = true;
      for (const fn of unlisteners) fn();
    });
  });

  const openCard = (msg: ChatMessage) => {
    if (msg.platform !== "Twitch" || !msg.platform_user_id) return;
    setCardUser({
      channel_id: msg.channel_id,
      platform_user_id: msg.platform_user_id,
      username: msg.username,
      display_name: msg.display_name,
      color: msg.color,
      badges: msg.badges,
    });
  };

  // Right-click on a row: viewer actions for everyone, moderation for mods.
  // Results and failures land on the transient notice line.
  const runModAction = (done: string, action: () => Promise<void>) => {
    action().then(
      () => notify(done),
      (raw: unknown) => {
        const err = toSendError(raw);
        notify(
          typeof err === "string"
            ? err
            : formatSendError(err as SendMessageError),
        );
      },
    );
  };

  const modTimeout = (msg: ChatMessage, seconds: number) =>
    runModAction(
      `Timed out ${msg.display_name} for ${formatSeconds(seconds)}`,
      () => timeoutUser(msg.channel_id, msg.platform_user_id, seconds),
    );

  const modBan = (msg: ChatMessage) =>
    runModAction(`Banned ${msg.display_name}`, () =>
      banUser(msg.channel_id, msg.platform_user_id),
    );

  const modDelete = (msg: ChatMessage) =>
    runModAction("Message deleted", async () => {
      await deleteMessage(msg.channel_id, msg.id);
      markMessageDeleted(msg.id);
    });

  // Hover icons for moderators: delete, the first timeout preset, ban.
  const showModIcons = (msg: ChatMessage) =>
    canModerate() &&
    msg.platform === "Twitch" &&
    msg.platform_user_id.length > 0 &&
    msg.username !== props.login;

  const copy = (text: string, done: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify(done),
      (err: unknown) => console.error("copy", err),
    );

  const replyTo = (msg: ChatMessage) =>
    requestReply({
      message_id: msg.id,
      user_login: msg.username,
      user_name: msg.display_name,
      body: msg.message_text,
    });

  // Reply and Copy show on hover for any ordinary message that has landed.
  const canReply = (msg: ChatMessage) =>
    msg.platform === "Twitch" &&
    msg.notice === null &&
    msg.status === undefined &&
    !msg.deleted &&
    msg.platform_user_id.length > 0;

  const openMenuFor = (e: MouseEvent, msg: ChatMessage) => {
    if (msg.platform !== "Twitch") return;
    const run = runModAction;
    const profile = `https://www.twitch.tv/${msg.username}`;
    openContextMenu(
      e,
      messageMenuItems(
        msg,
        {
          canModerate: canModerate(),
          ignored: isIgnored(msg.username),
          own: msg.username === props.login,
          timeouts: settings().timeoutPresets,
        },
        {
          reply: () => replyTo(msg),
          copyMessage: () => void copy(msg.message_text, "Message copied"),
          copyLogin: () => void copy(msg.username, "Name copied"),
          mention: () => requestMention(msg.username),
          viewProfile: () => openCard(msg),
          openOnTwitch: () =>
            void openUrl(profile).catch((err: unknown) =>
              console.error("open profile", err),
            ),
          toggleIgnore: () =>
            void setIgnored(msg.username, !isIgnored(msg.username)).catch(
              (err: unknown) => console.error("ignore", err),
            ),
          deleteMessage: () => modDelete(msg),
          timeout: (seconds) => modTimeout(msg, seconds),
          ban: () => modBan(msg),
          unban: () =>
            run(`Unbanned ${msg.display_name}`, () =>
              unbanUser(msg.channel_id, msg.platform_user_id),
            ),
        },
      ),
    );
  };

  return (
    <div class="feed" data-tour="feed">
      <div
        class="feed__scroll"
        ref={(el) => (containerRef = el)}
        onScroll={handleScroll}
      >
        <div
          class="feed__canvas"
          style={{ height: `${layout().totalHeight}px` }}
        >
          <For each={visibleMonos()}>
            {(mono) => {
              // Rows are keyed by message index, so a node lives as long as
              // its message is on screen and only its position updates.
              // Between a message leaving the layout and For dropping the
              // row, the last known placement keeps the accessor total.
              let last: PositionedMessage | undefined;
              const row = createMemo(() => {
                const next = layout().byMono.get(mono);
                if (next) last = next;
                return last!;
              });
              const status = () => row().msg.status;
              const newAccount = () => {
                userInfoRevision();
                return (
                  settings().flagNewAccounts &&
                  row().msg.platform === "Twitch" &&
                  !row().msg.notice &&
                  isNewAccount(userInfo(row().msg.platform_user_id), Date.now())
                );
              };
              const onRetry = () => {
                const localId = row().msg.local_id;
                if (!localId) return;
                const text = retryPending(localId);
                if (!text) return;
                sendMessage(
                  row().msg.channel_id,
                  text,
                  row().msg.reply_to ?? undefined,
                ).then(
                  (ok) => confirmPendingId(localId, ok.message_id),
                  (raw) => {
                    const err = toSendError(raw);
                    failPending(
                      localId,
                      typeof err === "string"
                        ? err
                        : formatSendError(err as SendMessageError),
                    );
                  },
                );
              };
              return (
                <div
                  class="msg"
                  classList={{
                    "msg--pending": status() === "pending",
                    "msg--failed": status() === "failed",
                    "msg--mention":
                      status() === undefined &&
                      !row().msg.notice &&
                      isHighlighted(
                        row().msg.message_text,
                        props.login,
                        settings().highlightPhrases,
                      ),
                    "msg--notice": row().msg.notice !== null,
                    "msg--deleted": row().msg.deleted === true,
                    "msg--alt":
                      settings().alternateRows && row().monoIndex % 2 === 1,
                    "msg--new-account": newAccount(),
                    "msg--spotlight":
                      status() === undefined &&
                      !row().msg.notice &&
                      isSpotlit(
                        row().msg.username,
                        row().msg.badges,
                        settings().highlightUsers,
                        settings().highlightBadges,
                      ),
                  }}
                  style={{
                    transform: `translateY(${row().top}px)`,
                    height: `${row().height}px`,
                    padding: `${MESSAGE_PADDING_Y / 2}px ${MESSAGE_PADDING_X}px`,
                    "line-height": `${row().prepared.metrics.lineHeight}px`,
                    "font-family": MESSAGE_FONT_FAMILY,
                    "font-size": `${row().prepared.metrics.fontSize}px`,
                  }}
                  title={
                    status() === "failed"
                      ? `${row().msg.error_message ?? "send failed"} (click or press Enter to retry)`
                      : undefined
                  }
                  role={status() === "failed" ? "button" : undefined}
                  tabIndex={status() === "failed" ? 0 : undefined}
                  aria-label={
                    status() === "failed"
                      ? `Send failed: ${row().msg.error_message ?? "unknown error"}. Activate to retry.`
                      : undefined
                  }
                  onClick={status() === "failed" ? onRetry : undefined}
                  onContextMenu={(e) => openMenuFor(e, row().msg)}
                  onKeyDown={
                    status() === "failed"
                      ? (e: KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRetry();
                          }
                        }
                      : undefined
                  }
                >
                  <Show
                    when={
                      status() === undefined &&
                      !row().msg.notice &&
                      !row().msg.deleted
                    }
                  >
                    <div class="msg__actions">
                      <Show when={canReply(row().msg)}>
                        <button
                          type="button"
                          class="msg__action"
                          title="Reply"
                          aria-label="Reply"
                          onClick={(e) => {
                            e.stopPropagation();
                            replyTo(row().msg);
                          }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M5 3 2 6l3 3M2 6h5a3 3 0 0 1 3 3v1"
                              stroke="currentColor"
                              stroke-width="1.4"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          class="msg__action"
                          title="Copy message"
                          aria-label="Copy message"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copy(row().msg.message_text, "Message copied");
                          }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            aria-hidden="true"
                          >
                            <rect
                              x="4"
                              y="4"
                              width="6.5"
                              height="6.5"
                              rx="1.2"
                              stroke="currentColor"
                              stroke-width="1.3"
                            />
                            <path
                              d="M8 4V2.7A1.2 1.2 0 0 0 6.8 1.5H2.7A1.2 1.2 0 0 0 1.5 2.7v4.1A1.2 1.2 0 0 0 2.7 8H4"
                              stroke="currentColor"
                              stroke-width="1.3"
                            />
                          </svg>
                        </button>
                      </Show>
                      <Show when={showModIcons(row().msg)}>
                        <button
                          type="button"
                          class="msg__action"
                          title="Delete message"
                          aria-label="Delete message"
                          onClick={(e) => {
                            e.stopPropagation();
                            modDelete(row().msg);
                          }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            aria-hidden="true"
                          >
                            <path
                              d="M3 3l6 6M9 3l-6 6"
                              stroke="currentColor"
                              stroke-width="1.5"
                              stroke-linecap="round"
                            />
                          </svg>
                        </button>
                        <Show when={settings().timeoutPresets[0]}>
                          {(seconds) => (
                            <button
                              type="button"
                              class="msg__action msg__action--text"
                              title={`Timeout ${formatSeconds(seconds())}`}
                              aria-label={`Timeout ${formatSeconds(seconds())}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                modTimeout(row().msg, seconds());
                              }}
                            >
                              {formatSeconds(seconds())}
                            </button>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="msg__action msg__action--danger"
                          title="Ban"
                          aria-label="Ban"
                          onClick={(e) => {
                            e.stopPropagation();
                            modBan(row().msg);
                          }}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                            aria-hidden="true"
                          >
                            <circle
                              cx="6"
                              cy="6"
                              r="4.3"
                              stroke="currentColor"
                              stroke-width="1.4"
                            />
                            <path
                              d="M3 9l6-6"
                              stroke="currentColor"
                              stroke-width="1.4"
                              stroke-linecap="round"
                            />
                          </svg>
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="msg__action"
                        title={`Reply to ${row().msg.display_name}`}
                        aria-label={`Reply to ${row().msg.display_name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          requestReply({
                            message_id: row().msg.id,
                            user_login: row().msg.username,
                            user_name: row().msg.display_name,
                            body: row().msg.message_text,
                          });
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M4.5 2.5 1.5 5.5l3 3M2 5.5h5a3 3 0 0 1 3 3V10"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </Show>
                  <Show when={row().prepared.replyParent}>
                    {(r) => (
                      <button
                        type="button"
                        class="msg__reply"
                        title="Show the whole thread"
                        style={{
                          height: `${row().prepared.metrics.lineHeight}px`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openThread(row().msg);
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M4.5 2.5 1.5 5.5l3 3M2 5.5h5a3 3 0 0 1 3 3V10"
                            stroke="currentColor"
                            stroke-width="1.4"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        <span class="msg__reply-user">
                          @{r().user_name || r().user_login}
                        </span>
                        <span class="msg__reply-body">{r().body}</span>
                      </button>
                    )}
                  </Show>
                  <Show when={row().prepared.timestamp}>
                    <span
                      class="msg__time"
                      style={{
                        "font-size": `${row().prepared.metrics.timestampSize}px`,
                      }}
                    >
                      {row().prepared.timestamp}
                    </span>
                  </Show>
                  <Show
                    when={row().prepared.notice}
                    fallback={
                      <>
                        <For each={row().prepared.badges}>
                          {(b) => (
                            <img
                              class="msg__badge"
                              src={b.badge.url_1x}
                              srcset={
                                b.badge.url_2x
                                  ? `${b.badge.url_1x} 1x, ${b.badge.url_2x} 2x${
                                      b.badge.url_4x
                                        ? `, ${b.badge.url_4x} 4x`
                                        : ""
                                    }`
                                  : undefined
                              }
                              alt={b.badge.title}
                              title={b.badge.title}
                              width={row().prepared.metrics.badgeSize}
                              height={row().prepared.metrics.badgeSize}
                              draggable={false}
                              style={{ "margin-right": `${BADGE_GAP_PX}px` }}
                            />
                          )}
                        </For>
                        <span
                          class="msg__user"
                          role="button"
                          tabIndex={0}
                          title={
                            newAccount()
                              ? "Account created in the last week"
                              : undefined
                          }
                          style={{
                            color: normalizeUserColor(
                              row().msg.color,
                              isLight(),
                            ),
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openCard(row().msg);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              openCard(row().msg);
                            }
                          }}
                        >
                          {row().msg.display_name}
                        </span>
                        <span class="msg__sep">: </span>
                        <MessagePieces pieces={row().prepared.pieces} />
                      </>
                    }
                  >
                    {(n) => (
                      <>
                        <span class="msg__notice">{n().system_message}</span>
                        <Show when={row().prepared.pieces.length > 0}>
                          {" "}
                          <MessagePieces pieces={row().prepared.pieces} />
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <Show when={fontsLoaded() && viewport().count === 0}>
        <EmptyState
          loading={channelStatus() === "connecting" || history.loading()}
        />
      </Show>

      <Show when={!stickToBottom()}>
        <button type="button" class="jump" onClick={jumpToLatest}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 2v8M2.5 6.5 6 10l3.5-3.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {unseenCount() > 0
            ? `${unseenCount()} new ${unseenCount() === 1 ? "message" : "messages"}`
            : "Jump to latest"}
        </button>
      </Show>

      <Show when={notice()}>
        {(n) => (
          <div class="feed__toast" role="status">
            {n()}
          </div>
        )}
      </Show>

      <UserCard
        user={cardUser()}
        login={props.login}
        onClose={() => setCardUser(null)}
      />
      <EmoteCard />
      <ContextMenu />
      <Thread />
    </div>
  );
};

const EmptyState: Component<{ loading: boolean }> = (props) => {
  const channel = () => activeChannel();
  const status = () => channelStatus();
  const opening = () => {
    const c = channel();
    return c ? `Opening ${c.display_name}` : "Finding the channel";
  };
  return (
    <div class="feed__empty" aria-live="polite">
      <Show
        when={channel()?.profile_image_url}
        fallback={<img class="feed__empty-logo" src={logo()} alt="" />}
      >
        {(url) => <img src={url()} alt="" />}
      </Show>
      <Show
        when={!props.loading}
        fallback={
          <>
            <span class="feed__spinner" aria-hidden="true" />
            <strong>{opening()}</strong>
          </>
        }
      >
        <Show
          when={channel()}
          fallback={
            <>
              <strong>No channel open</strong>
              <p>
                {status() === "error"
                  ? "That channel could not be opened. Pick another from the header."
                  : "Use the channel button in the header or press Ctrl+K."}
              </p>
            </>
          }
        >
          {(c) => (
            <Show
              when={!channelBanned()}
              fallback={
                <>
                  <strong>{bannedText(c().display_name)}</strong>
                  <p>{BANNED_HINT}</p>
                  <button
                    type="button"
                    class="feed__empty-action"
                    onClick={() => void rejoinChannel()}
                  >
                    Check again
                  </button>
                </>
              }
            >
              <strong>{c().display_name}</strong>
              <p>You're in. New messages show up here as they arrive.</p>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
};

export default ChatFeed;
