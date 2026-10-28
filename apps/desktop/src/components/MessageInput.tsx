// Chat send input pinned below the message feed. Single-line: Enter
// sends, Tab completes the emote or @mention under the caret, Up and Down
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
import {
  buildOptimisticMessage,
  confirmPendingId,
  failPending,
  insertPending,
  type EmoteMeta,
} from "../stores/chatStore";
import { activeChannel, channelBanned } from "../stores/channelStore";
import { bannedText } from "../lib/chatAccess";
import { chatterByLogin, recentChatters } from "../stores/chatterStore";
import { lookupUser, formatChannelError } from "../lib/twitchChannel";
import { banUser, timeoutUser, unbanUser } from "../lib/twitchAuth";
import { parseInput, type SlashCommand } from "../lib/slashCommands";
import {
  clearReply,
  insertRequest,
  replyTarget,
} from "../stores/composerStore";
import { allEmotes, emoteRevision } from "../stores/emoteStore";
import { moderationNeedsReconnect } from "../stores/authStore";
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
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [status, setStatus] = createSignal<string | null>(null);
  // Index into candidates(); -1 means nothing picked yet, so Enter sends.
  const [highlight, setHighlight] = createSignal(-1);
  // Escape hides suggestions for the word being typed; any edit re-arms.
  const [dismissed, setDismissed] = createSignal(false);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;
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

  const canSend = () =>
    activeChannel() !== null &&
    !channelBanned() &&
    normalizeOutgoing(text()) !== null;

  const word = createMemo(() => wordAtCaret(text(), caret()));
  const candidates = createMemo(() => {
    emoteRevision();
    if (dismissed()) return [];
    return complete(word().word, allEmotes(), recentChatters());
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
    const known = chatterByLogin(login);
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
    if (!channel) return;
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
    const optimistic = buildOptimisticMessage({
      platform: "Twitch",
      login: props.login,
      text: payload,
      channelId: channel.id,
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
    insertPending(optimistic);
    const localId = optimistic.local_id!;
    const submitSeq = ++lastSubmitSeq;

    sendMessage(channel.id, payload, reply?.message_id).then(
      (ok) => {
        confirmPendingId(localId, ok.message_id);
      },
      (raw) => {
        const err = toSendError(raw);
        const message =
          typeof err === "string"
            ? err
            : formatSendError(err as SendMessageError);
        failPending(localId, message);
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
        e.preventDefault();
        if (n > 0) setHighlight((h) => (h + 1) % n);
        else recall(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (n > 0) setHighlight((h) => (h <= 0 ? n - 1 : h - 1));
        else recall(-1);
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

  const syncCaret = (el: HTMLInputElement) => {
    setCaret(el.selectionStart ?? el.value.length);
  };

  const placeholder = () => {
    const c = activeChannel();
    if (!c) return "Pick a channel to chat";
    return channelBanned()
      ? bannedText(c.display_name)
      : `Message ${c.display_name}`;
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
        <input
          ref={(el) => (inputEl = el)}
          class="composer__input"
          type="text"
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
      <Show when={status()}>
        <div class="composer__status" role="status">
          {status()}
        </div>
      </Show>
    </div>
  );
};

export default MessageInput;
