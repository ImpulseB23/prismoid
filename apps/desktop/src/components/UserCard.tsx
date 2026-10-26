// Opens when a username in the feed is clicked. Shows who they are, the
// badges they hold in this channel, what they said recently, and the
// actions a viewer or moderator can take on them.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  banUser,
  deleteMessage,
  timeoutUser,
  unbanUser,
  type SendMessageError,
} from "../lib/twitchAuth";
import { formatSendError, toSendError } from "../lib/messageInput";
import { splitMessage } from "../lib/emoteSpans";
import { MESSAGE_LINE_HEIGHT } from "../lib/messageLayout";
import { formatTimestamp, normalizeUserColor } from "../lib/messageStyle";
import { resolveBadge, badgeRevision } from "../stores/badgeStore";
import {
  markMessageDeleted,
  messageRevision,
  recentMessagesByUser,
  viewport,
  type ChatMessage,
} from "../stores/chatStore";
import { requestMention } from "../stores/composerStore";
import { moderationNeedsReconnect } from "../stores/authStore";
import { chatterStats } from "../stores/chatterStore";
import { modActionsFor, modLogRevision } from "../stores/modLogStore";
import { describeModAction } from "../lib/modActions";
import { formatSeconds } from "../lib/slashCommands";
import { canModerate } from "../stores/roleStore";
import {
  isIgnored,
  noteFor,
  setIgnored,
  setNote,
  settings,
} from "../stores/settingsStore";
import {
  ensureUserInfo,
  formatJoined,
  isNewAccount,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";
import MessagePieces from "./MessagePieces";

export interface CardUser {
  /** Channel the card was opened in; every action targets it. */
  channel_id: string;
  platform_user_id: string;
  username: string;
  display_name: string;
  color: string | null;
  badges: ChatMessage["badges"];
}

export interface UserCardProps {
  user: CardUser | null;
  onClose: () => void;
}

const RECENT_LIMIT = 20;

type Pending = "none" | "timeout" | "ban" | "confirm_ban" | "unban" | "delete";

const UserCard: Component<UserCardProps> = (props) => {
  const [pending, setPending] = createSignal<Pending>("none");
  const [notice, setNotice] = createSignal<string | null>(null);
  // Free-text reason sent with the next timeout or ban. Twitch shows it to
  // other moderators, not to the chatter.
  const [reason, setReason] = createSignal("");
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.user) queueMicrotask(() => dialogRef?.focus());
  });

  const badges = createMemo(() => {
    badgeRevision();
    const u = props.user;
    if (!u) return [];
    return u.badges.flatMap((b) => {
      const r = resolveBadge(b.set_id, b.id);
      return r ? [r] : [];
    });
  });

  const recent = createMemo(() => {
    viewport();
    messageRevision();
    const u = props.user;
    return u ? recentMessagesByUser(u.platform_user_id, RECENT_LIMIT) : [];
  });

  const ignored = () => {
    settings();
    return props.user ? isIgnored(props.user.username) : false;
  };

  const profile = () => {
    userInfoRevision();
    const u = props.user;
    if (!u) return undefined;
    ensureUserInfo([u.platform_user_id]);
    return userInfo(u.platform_user_id);
  };

  const stats = () => {
    viewport();
    const u = props.user;
    return u ? chatterStats(u.platform_user_id) : undefined;
  };

  const history = () => {
    modLogRevision();
    const u = props.user;
    return u ? modActionsFor(u.platform_user_id) : [];
  };

  const close = () => {
    setPending("none");
    setNotice(null);
    props.onClose();
  };

  const runMod = async (
    kind: Exclude<Pending, "none" | "confirm_ban">,
    action: () => Promise<void>,
    done: string,
  ) => {
    setPending(kind);
    setNotice(null);
    try {
      await action();
      setNotice(done);
    } catch (raw) {
      const err = toSendError(raw);
      setNotice(
        typeof err === "string"
          ? err
          : formatSendError(err as SendMessageError),
      );
    } finally {
      setPending("none");
    }
  };

  return (
    <Show when={props.user}>
      {(u) => (
        <div class="dialog-backdrop" onMouseDown={close}>
          <div
            ref={(el) => (dialogRef = el)}
            tabIndex={-1}
            class="dialog user-card"
            role="dialog"
            aria-modal="true"
            aria-label={`${u().display_name} profile`}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
          >
            <div class="user-card__head">
              <div class="user-card__identity">
                <Show when={profile()?.profile_image_url}>
                  {(url) => (
                    <img
                      class="user-card__avatar"
                      src={url()}
                      alt=""
                      width={36}
                      height={36}
                    />
                  )}
                </Show>
                <div class="user-card__names">
                  <span
                    class="user-card__name"
                    style={{ color: normalizeUserColor(u().color) }}
                  >
                    {u().display_name}
                  </span>
                  <Show when={u().username !== u().display_name.toLowerCase()}>
                    <span class="user-card__login">{u().username}</span>
                  </Show>
                </div>
              </div>
              <div class="user-card__facts">
                <Show when={profile()}>
                  {(p) => (
                    <span
                      classList={{
                        "user-card__fact": true,
                        "user-card__fact--new": isNewAccount(p(), Date.now()),
                      }}
                    >
                      {formatJoined(p().created_at, Date.now())}
                    </span>
                  )}
                </Show>
                <Show when={stats()}>
                  {(s) => (
                    <span class="user-card__fact">
                      {s().messages}{" "}
                      {s().messages === 1 ? "message" : "messages"} this session
                    </span>
                  )}
                </Show>
              </div>
              <Show when={profile()?.description}>
                {(d) => <p class="user-card__bio">{d()}</p>}
              </Show>
              <Show when={badges().length > 0}>
                <div class="user-card__badges">
                  <For each={badges()}>
                    {(b) => (
                      <span class="user-card__badge" title={b.title}>
                        <img src={b.url_1x} alt="" width={18} height={18} />
                        {b.title}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <div class="user-card__actions">
              <button
                type="button"
                class="btn btn--outline"
                onClick={() => {
                  requestMention(u().username);
                  close();
                }}
              >
                Mention
              </button>
              <button
                type="button"
                class="btn btn--outline"
                onClick={() =>
                  void openUrl(`https://www.twitch.tv/${u().username}`).catch(
                    (err: unknown) => console.error("open profile", err),
                  )
                }
              >
                Open on Twitch
              </button>
              <button
                type="button"
                class="btn btn--outline"
                onClick={() =>
                  void setIgnored(u().username, !ignored()).catch(
                    (err: unknown) => console.error("ignore", err),
                  )
                }
              >
                {ignored() ? "Unignore" : "Ignore"}
              </button>
            </div>

            <div class="dialog__label">Your note</div>
            <textarea
              class="user-card__note"
              rows={2}
              placeholder="Only you see this. Why they are on your radar, what they said last stream."
              value={noteFor(u().username)}
              onChange={(e) =>
                void setNote(u().username, e.currentTarget.value).catch(
                  (err: unknown) => console.error("save note", err),
                )
              }
            />

            <Show when={history().length > 0}>
              <div class="dialog__label">Moderation history</div>
              <div class="user-card__history">
                <For each={history()}>
                  {(a) => (
                    <div class="user-card__history-row">
                      <span class="msg__time">
                        {formatTimestamp(a.timestamp)}
                      </span>
                      <span>{describeModAction(a)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={moderationNeedsReconnect()}>
              <div class="dialog__label">Moderation</div>
              <div class="dialog__empty">
                Moderation needs new Twitch permissions. Reconnect in Settings.
              </div>
            </Show>
            <Show when={canModerate()}>
              <div class="dialog__label">Moderation</div>
              <input
                type="text"
                class="settings__input user-card__reason"
                placeholder="Reason (other mods see it)"
                value={reason()}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
              <div class="user-card__actions">
                <For each={settings().timeoutPresets}>
                  {(seconds) => (
                    <button
                      type="button"
                      class="btn btn--outline"
                      disabled={pending() !== "none"}
                      onClick={() =>
                        void runMod(
                          "timeout",
                          () =>
                            timeoutUser(
                              u().channel_id,
                              u().platform_user_id,
                              seconds,
                              reason().trim() || undefined,
                            ),
                          `Timed out ${u().display_name} for ${formatSeconds(seconds)}.`,
                        )
                      }
                    >
                      {formatSeconds(seconds)}
                    </button>
                  )}
                </For>
                <Show
                  when={pending() === "confirm_ban"}
                  fallback={
                    <button
                      type="button"
                      class="btn btn--outline btn--danger"
                      disabled={pending() !== "none"}
                      onClick={() => setPending("confirm_ban")}
                    >
                      Ban
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="btn btn--outline btn--danger"
                    onClick={() =>
                      void runMod(
                        "ban",
                        () =>
                          banUser(
                            u().channel_id,
                            u().platform_user_id,
                            reason().trim() || undefined,
                          ),
                        `Banned ${u().display_name}.`,
                      )
                    }
                  >
                    Confirm ban
                  </button>
                </Show>
                <button
                  type="button"
                  class="btn btn--outline"
                  disabled={pending() !== "none"}
                  onClick={() =>
                    void runMod(
                      "unban",
                      () => unbanUser(u().channel_id, u().platform_user_id),
                      `Unbanned ${u().display_name}.`,
                    )
                  }
                >
                  {pending() === "unban" ? "Unbanning…" : "Unban"}
                </button>
              </div>
            </Show>

            <Show when={notice()}>
              {(n) => (
                <div class="user-card__notice" role="status">
                  {n()}
                </div>
              )}
            </Show>

            <div class="dialog__label">Recent messages</div>
            <div class="user-card__messages">
              <Show
                when={recent().length > 0}
                fallback={
                  <div class="dialog__empty">
                    Nothing from {u().display_name} in this session yet.
                  </div>
                }
              >
                <For each={recent()}>
                  {(m) => (
                    <div
                      class="user-card__msg"
                      classList={{
                        "user-card__msg--deleted": m.deleted === true,
                      }}
                    >
                      <span class="msg__time">
                        {formatTimestamp(m.timestamp)}
                      </span>
                      <span class="user-card__msg-text">
                        <MessagePieces
                          pieces={splitMessage(m.message_text, m.emote_spans, {
                            maxHeight: MESSAGE_LINE_HEIGHT,
                          })}
                        />
                      </span>
                      <Show when={!m.deleted && canModerate()}>
                        <button
                          type="button"
                          class="user-card__msg-delete"
                          title="Delete message"
                          aria-label="Delete message"
                          disabled={pending() !== "none"}
                          onClick={() =>
                            void runMod(
                              "delete",
                              async () => {
                                await deleteMessage(m.channel_id, m.id);
                                markMessageDeleted(m.id);
                              },
                              "Message deleted.",
                            )
                          }
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
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default UserCard;
