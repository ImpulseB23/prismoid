// Chat send box pinned below the message feed. It wraps and grows for long
// messages, but Enter always sends (Twitch messages are one line), Tab completes the emote or @mention under the caret, Up and Down
// walk through sent messages, and the inline status row surfaces drop
// reasons or transport errors from the Tauri command.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import {
  MAX_CHAT_MESSAGE_BYTES,
  sendMessage,
  type SendMessageError,
} from "../lib/twitchAuth";
import {
  fitsLimit,
  formatSendError,
  normalizeOutgoing,
  toSendError,
} from "../lib/messageInput";
import {
  applyCompletion,
  complete,
  wordAtCaret,
  type Candidate,
} from "../lib/completion";
import { buildOptimisticMessage, type EmoteMeta } from "../stores/chatStore";
import { useSession } from "../lib/chatSession";
import { activeChannel, channelBanned } from "../stores/channelStore";
import { bannedText } from "../lib/chatAccess";
import { lookupUser, formatChannelError } from "../lib/twitchChannel";
import { banUser, timeoutUser, unbanUser } from "../lib/twitchAuth";
import { parseInput, type SlashCommand } from "../lib/slashCommands";
import {
  clearReply,
  insertRequest,
  replyTarget,
} from "../stores/composerStore";
import { allEmotes, emoteByCode, emoteRevision } from "../stores/emoteStore";
import { scanEmotes } from "../lib/emoteSpans";
import {
  ownBadges,
  ownColor,
  ownDisplayName,
} from "../stores/ownIdentityStore";
import { currentUserId, moderationNeedsReconnect } from "../stores/authStore";
import { chatSettings } from "../stores/chatSettingsStore";
import { modActionsFor } from "../stores/modLogStore";
import {
  COUNTER_FROM,
  bytesLeft,
  slowModeLeft,
  timeoutLeft,
} from "../lib/composerMeta";
import { canModerate } from "../stores/roleStore";
import { formatSeconds } from "../lib/slashCommands";
import EmotePicker from "./EmotePicker";

interface Props {
  /** Current Twitch login of the signed-in user. Used as both the
   * username and provisional display name on the optimistic message;
   * the authoritative EventSub echo replaces both fields when it
   * arrives. */
  login: string;
}

const PROVIDER_LABEL: Record<EmoteMeta["provider"], string> = {
  twitch: "Twitch",
  "7tv": "7TV",
  bttv: "BTTV",
  ffz: "FFZ",
};

const HISTORY_LIMIT = 50;

const MessageInput: Component<Props> = (props) => {
  const session = useSession();
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [status, setStatus] = createSignal<string | null>(null);
  // Index into candidates(); -1 means nothing picked yet, so Enter sends.
  const [highlight, setHighlight] = createSignal(-1);
  // Escape hides suggestions for the word being typed; any edit re-arms.
  const [dismissed, setDismissed] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  let inputEl: HTMLTextAreaElement | undefined;
  // Per-input monotonic counter. Pending-entry mutations are already
  // safely keyed by `local_id`, but the inline status string is shared
  // across submits, so a slower earlier rejection could otherwise stomp
  // a newer success. We snapshot the seq at submit time and only let
  // the handler call `setStatus` when its snapshot is still the latest.
  let lastSubmitSeq = 0;
  // Sent messages, oldest first. `historyIndex` is where Up/Down stands;
  // equal to history.length means "the live draft", kept in `draft`.
  const history: string[] = [];
  let historyIndex = 0;
  let draft = "";
  // When this user last sent in each channel, for the slow mode countdown.
  const [lastSent, setLastSent] = createSignal(new Map<string, number>());
  const [now, setNow] = createSignal(Date.now());

  const role = () => {
    const c = activeChannel();
    if (c && c.id === currentUserId()) return "Streamer";
    return canModerate() ? "Mod" : null;
  };
  const slowLeft = () => {
    const c = activeChannel();
    return c
      ? slowModeLeft(
          chatSettings(),
          lastSent().get(c.id),
          now(),
          role() !== null,
        )
      : 0;
  };
  const timedOutLeft = () => {
    const c = activeChannel();
    const me = currentUserId();
    return c && me ? timeoutLeft(modActionsFor(me), c.id, now()) : 0;
  };
  const left = () => bytesLeft(text());

  // Ticks once a second only while a countdown is on screen.
  createEffect(() => {
    if (slowLeft() === 0 && timedOutLeft() === 0) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(tick));
  });

  const canSend = () =>
    activeChannel() !== null &&
    !channelBanned() &&
    slowLeft() === 0 &&
    normalizeOutgoing(text()) !== null;

  const word = createMemo(() => wordAtCaret(text(), caret()));
  const candidates = createMemo(() => {
    emoteRevision();
    if (dismissed()) return [];
    return complete(
      word().word,
      allEmotes(),
      session()?.chatters.recent() ?? [],
    );
  });
  const open = () => candidates().length > 0;

  const setDraft = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setHighlight(-1);
    setDismissed(false);
  };

  const focusAt = (at: number) => {
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.setSelectionRange(at, at);
    });
  };

  const insertAtCaret = (snippet: string) => {
    const t = text();
    const at = caret();
    const before = t.slice(0, at);
    const after = t.slice(at);
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const trail = /^\s/.test(after) ? "" : " ";
    const next = `${before}${lead}${snippet}${trail}${after}`;
    const pos = before.length + lead.length + snippet.length + trail.length;
    setDraft(next, pos);
    focusAt(pos);
  };

  // Text handed over by another surface (a mention, an emote) lands at the end of the draft.
  createEffect(
    on(insertRequest, (req) => {
      if (!req) return;
      setCaret(text().length);
      insertAtCaret(req.text);
    }),
  );

  createEffect(
    on(replyTarget, (target) => {
      if (target) focusAt(text().length);
    }),
  );

  const accept = (c: Candidate) => {
    const applied = applyCompletion(text(), word(), c.insert);
    setDraft(applied.text, applied.caret);
    focusAt(applied.caret);
  };

  const recall = (direction: -1 | 1) => {
    const next = historyIndex + direction;
    if (next < 0 || next > history.length) return;
    if (historyIndex === history.length) draft = text();
    historyIndex = next;
    const value = next === history.length ? draft : history[next]!;
    setDraft(value, value.length);
    focusAt(value.length);
  };

  const resolveId = async (login: string): Promise<string> => {
    const known = session()?.chatters.byLogin(login);
    if (known) return known.id;
    return (await lookupUser(login)).id;
  };

  const runCommand = async (command: SlashCommand) => {
    const channel = activeChannel();
    if (!channel) return;
    const seq = ++lastSubmitSeq;
    const report = (message: string) => {
      if (seq === lastSubmitSeq) setStatus(message);
    };
    try {
      switch (command.kind) {
        case "ban":
          await banUser(
            channel.id,
            await resolveId(command.login),
            command.reason,
          );
          report(`Banned ${command.login}.`);
          return;
        case "unban":
          await unbanUser(channel.id, await resolveId(command.login));
          report(`Unbanned ${command.login}.`);
          return;
        case "timeout":
          await timeoutUser(
            channel.id,
            await resolveId(command.login),
            command.seconds,
            command.reason,
          );
          report(
            `Timed out ${command.login} for ${formatSeconds(command.seconds)}.`,
          );
          return;
      }
    } catch (raw) {
      const err = toSendError(raw);
      report(
        typeof err === "string"
          ? formatChannelError(raw)
          : formatSendError(err as SendMessageError),
      );
    }
  };

  const submit = () => {
    const channel = activeChannel();
    // Kept for Twitch's answer: by then the pane may show another channel,
    // and the message still belongs to the session it went into.
    const store = session()?.chat;
    if (!channel || !store) return;
    const parsed = parseInput(text().trim());
    if (parsed.kind === "error") {
      setStatus(parsed.message);
      return;
    }
    let body = parsed.kind === "message" ? parsed.text : "";
    if (parsed.kind === "command") {
      if (parsed.command.kind !== "me") {
        if (!canModerate()) {
          setStatus(
            moderationNeedsReconnect()
              ? "Moderation needs new Twitch permissions. Reconnect in Settings."
              : `You are not a moderator in ${channel.display_name}.`,
          );
          return;
        }
        const command = parsed.command;
        setDraft("", 0);
        setStatus(null);
        void runCommand(command);
        return;
      }
      body = `/me ${parsed.command.text}`;
    }
    if (slowLeft() > 0) {
      setStatus(`Slow mode: wait ${formatSeconds(slowLeft())}.`);
      return;
    }
    const payload = normalizeOutgoing(body);
    if (!payload) {
      setStatus("Message is empty.");
      return;
    }
    if (!fitsLimit(payload)) {
      setStatus(`Message exceeds ${MAX_CHAT_MESSAGE_BYTES} bytes.`);
      return;
    }
    if (history[history.length - 1] !== payload) {
      history.push(payload);
      if (history.length > HISTORY_LIMIT) history.shift();
    }
    historyIndex = history.length;
    draft = "";
    setDraft("", 0);
    setStatus(null);
    inputEl?.focus();

    const reply = replyTarget();
    clearReply();
    const me = currentUserId();
    const optimistic = buildOptimisticMessage({
      platform: "Twitch",
      login: props.login,
      text: payload,
      channelId: channel.id,
      look: me
        ? {
            userId: me,
            displayName: ownDisplayName(channel.id),
            color: ownColor(),
            badges: ownBadges(channel.id),
            emoteSpans: scanEmotes(payload, emoteByCode),
          }
        : undefined,
    });
    if (reply) {
      optimistic.reply_to = reply.message_id;
      optimistic.reply_parent = {
        user_login: reply.user_login,
        user_name: reply.user_name,
        body: reply.body,
        thread_id: "",
      };
    }
    store.insertPending(optimistic);
    setLastSent((m) => new Map(m).set(channel.id, Date.now()));
    setNow(Date.now());
    const localId = optimistic.local_id!;
    const submitSeq = ++lastSubmitSeq;

    sendMessage(channel.id, payload, reply?.message_id).then(
      (ok) => {
        store.confirmPendingId(localId, ok.message_id);
      },
      (raw) => {
        const err = toSendError(raw);
        const message =
          typeof err === "string"
            ? err
            : formatSendError(err as SendMessageError);
        store.failPending(localId, message);
        if (submitSeq === lastSubmitSeq) setStatus(message);
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = candidates();
    const n = list.length;
    switch (e.key) {
      case "Tab":
        if (n === 0) return;
        e.preventDefault();
        accept(list[Math.max(0, highlight())]!);
        return;
      case "ArrowDown":
        if (n > 0) {
          e.preventDefault();
          setHighlight((h) => (h + 1) % n);
        } else if (!wrapped()) {
          e.preventDefault();
          recall(1);
        }
        return;
      case "ArrowUp":
        if (n > 0) {
          e.preventDefault();
          setHighlight((h) => (h <= 0 ? n - 1 : h - 1));
        } else if (!wrapped()) {
          e.preventDefault();
          recall(-1);
        }
        return;
      case "Escape":
        if (n > 0) {
          e.preventDefault();
          setDismissed(true);
        } else if (replyTarget()) {
          e.preventDefault();
          clearReply();
        }
        return;
      case "Enter": {
        e.preventDefault();
        const h = highlight();
        if (n > 0 && h >= 0) accept(list[h]!);
        else submit();
        return;
      }
    }
  };

  // A draft that wraps onto a second line keeps Up and Down for moving the
  // caret between lines; a one-line draft uses them to walk history.
  const wrapped = () => {
    if (!inputEl) return false;
    const line = parseFloat(getComputedStyle(inputEl).lineHeight);
    return Number.isFinite(line) && inputEl.clientHeight > line * 1.5;
  };

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length);
  };

  const placeholder = () => {
    const c = activeChannel();
    if (!c) return "Pick a channel to chat";
    return channelBanned() ? bannedText(c.display_name) : "Send a message";
  };

  return (
    <div class="composer">
      <Show when={open() && !pickerOpen()}>
        <div class="completion" role="listbox" aria-label="Suggestions">
          <For each={candidates()}>
            {(c, i) => (
              <div
                class="completion__item"
                role="option"
                aria-selected={highlight() === i()}
                onMouseEnter={() => setHighlight(i())}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(c);
                }}
              >
                <Show
                  when={c.kind === "emote" ? c : null}
                  fallback={<span class="completion__at">@</span>}
                >
                  {(ec) => (
                    <img
                      src={ec().emote.url_1x}
                      alt=""
                      width={24}
                      height={24}
                      draggable={false}
                    />
                  )}
                </Show>
                <span class="completion__code">
                  {c.kind === "emote" ? c.emote.code : c.chatter.display_name}
                </span>
                <span class="completion__meta">
                  {c.kind === "emote"
                    ? PROVIDER_LABEL[c.emote.provider]
                    : c.chatter.login}
                </span>
              </div>
            )}
          </For>
          <div class="completion__hint">
            <kbd>Tab</kbd> complete
          </div>
        </div>
      </Show>
      <EmotePicker
        open={pickerOpen()}
        onPick={(e) => insertAtCaret(e.code)}
        onClose={() => setPickerOpen(false)}
      />
      <Show when={replyTarget()}>
        {(r) => (
          <div class="composer__reply">
            <span class="composer__reply-label">
              Replying to @{r().user_name || r().user_login}
            </span>
            <span class="composer__reply-body">{r().body}</span>
            <button
              type="button"
              class="icon-btn composer__reply-close"
              aria-label="Cancel reply"
              title="Cancel reply (Esc)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearReply}
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
        )}
      </Show>
      <div class="composer__row">
        <textarea
          ref={(el) => (inputEl = el)}
          class="composer__input"
          rows={1}
          aria-label="Send a chat message"
          autocomplete="off"
          spellcheck={false}
          value={text()}
          placeholder={placeholder()}
          disabled={activeChannel() === null || channelBanned()}
          onInput={(e) => {
            setDraft(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? e.currentTarget.value.length,
            );
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => syncCaret(e.currentTarget)}
        />
        <button
          type="button"
          class="icon-btn composer__emotes"
          aria-label="Emotes"
          title="Emotes"
          aria-expanded={pickerOpen()}
          disabled={activeChannel() === null || channelBanned()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPickerOpen((v) => !v)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="6.25"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <path
              d="M5.25 9.5a3.25 3.25 0 0 0 5.5 0"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
            <circle cx="6" cy="6.5" r="0.9" fill="currentColor" />
            <circle cx="10" cy="6.5" r="0.9" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="composer__send"
          aria-label="Send"
          title="Send (Enter)"
          disabled={!canSend()}
          onClick={() => void submit()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 7h9M7.5 3.5 11 7l-3.5 3.5"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      <Show
        when={
          activeChannel() &&
          (timedOutLeft() > 0 || slowLeft() > 0 || left() <= COUNTER_FROM)
        }
      >
        <div class="composer__meta">
          <Show
            when={timedOutLeft() > 0 || slowLeft() > 0}
            fallback={
              <span
                class="composer__count"
                classList={{ "composer__count--over": left() < 0 }}
              >
                {left()}
              </span>
            }
          >
            <span class="composer__wait" role="timer">
              {timedOutLeft() > 0
                ? `Timed out, ${formatSeconds(timedOutLeft())} left`
                : `Slow mode, ${formatSeconds(slowLeft())}`}
            </span>
          </Show>
        </div>
      </Show>
      <Show when={status()}>
        <div class="composer__status" role="status">
          {status()}
        </div>
      </Show>
    </div>
  );
};

export default MessageInput;
