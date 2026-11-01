// Opens when a username in the feed is clicked. Shows who they are, the
// badges they hold in this channel, what they said recently, and the
// actions a viewer or moderator can take on them.

import {
  Component,
  JSX,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  banUser,
  deleteMessage,
  timeoutUser,
  unbanUser,
  type SendMessageError,
} from "../lib/twitchAuth";
import { formatSendError, toSendError } from "../lib/messageInput";
import { formatTimestamp } from "../lib/messageStyle";
import { nameStyle } from "../lib/paint";
import { shownPaint } from "../stores/paintStore";
import { nameContrast } from "../stores/themeStore";
import type { BadgeStore } from "../stores/badgeStore";
import type { ChatMessage, ChatStore } from "../stores/chatStore";
import { currentUserId, moderationNeedsReconnect } from "../stores/authStore";
import {
  describeSub,
  getFollowerCount,
  getFollowSince,
  getSubAge,
} from "../lib/twitchChannel";
import { followLookup } from "../lib/cardFacts";
import { formatViewers } from "../lib/streamInfo";
import { modActionsFor, modLogRevision } from "../stores/modLogStore";
import { describeModAction } from "../lib/modActions";
import { formatSeconds } from "../lib/slashCommands";
import { canModerateIn } from "../stores/roleStore";
import {
  isIgnored,
  isUserHighlighted,
  setIgnored,
  setUserHighlighted,
  settings,
} from "../stores/settingsStore";
import { isHighlighted } from "../lib/highlight";
import {
  ensureUserInfo,
  formatJoined,
  formatSince,
  isNewAccount,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";
import MessagePieces from "./MessagePieces";
import { splitMessage } from "../lib/emoteSpans";
import { item, openContextMenu, separator } from "../stores/contextMenuStore";

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
  /** Their messages in the card's channel. */
  chat: ChatStore;
  /** The card's channel's badges. */
  badges: BadgeStore;
  /** Signed-in login, so messages that mention it are highlighted. */
  login: string;
  onClose: () => void;
  /** The window's own buttons (pin, close), at the header's right. */
  controls?: JSX.Element;
  /** Starts a reply to them in the main window's chat box. */
  onMention: (login: string) => void;
  /** Shows one of their messages in the main window's chat. */
  onJump: (msg: ChatMessage) => void;
}

/** One click each, from a second to a week, like a chat client's card. */
const CARD_TIMEOUTS = [1, 30, 60, 300, 1800, 3600, 86_400, 604_800];

/** Emotes in the card's message lines fit this, in CSS pixels. */
const CARD_LINE_HEIGHT = 20;

const RECENT_LIMIT = 20;

type Pending = "none" | "timeout" | "ban" | "confirm_ban" | "unban" | "delete";
type Tab = "messages" | "history";

const UserCard: Component<UserCardProps> = (props) => {
  const [pending, setPending] = createSignal<Pending>("none");
  const [notice, setNotice] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<Tab>("messages");
  const [copied, setCopied] = createSignal(false);
  const [bigAvatar, setBigAvatar] = createSignal(false);
  const [bioOpen, setBioOpen] = createSignal(false);
  let dialogRef: HTMLElement | undefined;
  let listRef: HTMLDivElement | undefined;
  // The list follows new messages while it is at the bottom; scrolled up
  // to read, it stays put.
  let atEnd = true;

  const isSelf = () => props.user?.platform_user_id === currentUserId();
  // Twitch never lets anyone time out or ban themselves or the channel's
  // owner, so the card does not offer it.
  const canTarget = () =>
    !isSelf() && props.user?.platform_user_id !== props.user?.channel_id;
  // The card acts in the channel it was opened from, whatever is on screen.
  const moderates = () =>
    props.user ? canModerateIn(props.user.channel_id) : false;

  // A new person starts fresh: their messages, no leftover notice.
  createEffect(
    on(
      () => props.user?.platform_user_id,
      (id) => {
        if (id === undefined) return;
        setTab("messages");
        setPending("none");
        setNotice(null);
        setCopied(false);
        setBigAvatar(false);
        setBioOpen(false);
        atEnd = true;
        queueMicrotask(() => dialogRef?.focus());
      },
    ),
  );

  const lineBadges = (m: ChatMessage) => {
    props.badges.revision();
    return m.badges.flatMap((b) => {
      const r = props.badges.resolve(b.set_id, b.id);
      return r ? [r] : [];
    });
  };

  const badges = createMemo(() => {
    const store = props.badges;
    store.revision();
    const u = props.user;
    if (!u) return [];
    return u.badges.flatMap((b) => {
      const r = store.resolve(b.set_id, b.id);
      return r ? [r] : [];
    });
  });

  const name = createMemo(() => {
    const u = props.user;
    return nameStyle(
      u?.color,
      u ? shownPaint(u.platform_user_id) : undefined,
      nameContrast(),
    );
  });

  const recent = createMemo(() => {
    const chat = props.chat;
    chat.viewport();
    chat.messageRevision();
    const u = props.user;
    return u ? chat.recentByUser(u.platform_user_id, RECENT_LIMIT) : [];
  });

  createEffect(
    on([recent, tab], () => {
      if (listRef && atEnd) listRef.scrollTop = listRef.scrollHeight;
    }),
  );

  const ignored = () => {
    settings();
    return props.user ? isIgnored(props.user.username) : false;
  };

  const spotlit = () => {
    settings();
    return props.user ? isUserHighlighted(props.user.username) : false;
  };

  const profile = () => {
    userInfoRevision();
    const u = props.user;
    if (!u) return undefined;
    ensureUserInfo([u.platform_user_id]);
    return userInfo(u.platform_user_id);
  };

  // Where Twitch will not say, the stat stays off rather than guessing.
  const [following] = createResource(
    () => (props.user ? followLookup(props.user) : false),
    ([channel, user]) => getFollowSince(channel, user),
  );

  // ivr.fi knows anyone's sub, and sometimes their follow, in any channel.
  const channelLogin = () => {
    userInfoRevision();
    const u = props.user;
    if (!u) return undefined;
    ensureUserInfo([u.channel_id]);
    return userInfo(u.channel_id)?.login;
  };
  const [subage] = createResource(
    () => {
      const u = props.user;
      const channel = channelLogin();
      return u && channel ? ([u.username, channel] as const) : false;
    },
    ([user, channel]) => getSubAge(user, channel),
  );
  const sub = () => (subage.state === "ready" ? describeSub(subage()) : null);
  const [followers] = createResource(
    () => props.user?.platform_user_id,
    (id) => getFollowerCount(id),
  );
  const followedAt = () =>
    (following.state === "ready" ? following() : null) ??
    (subage.state === "ready" ? subage().followed_at : null);

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));
  const copyId = (id: string) =>
    navigator.clipboard.writeText(id).then(
      () => {
        setCopied(true);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied(false), 1500);
      },
      (err: unknown) => console.error("copy user id", err),
    );

  const history = () => {
    modLogRevision();
    const u = props.user;
    return u
      ? modActionsFor(u.platform_user_id).filter(
          (a) => a.channel_id === u.channel_id,
        )
      : [];
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

  const busy = () => pending() !== "none" && pending() !== "confirm_ban";

  return (
    <Show when={props.user}>
      {(u) => (
        <main
          ref={(el) => (dialogRef = el)}
          tabIndex={-1}
          class="user-card"
          aria-label={`${u().display_name} profile`}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            if (bigAvatar()) setBigAvatar(false);
            else close();
          }}
        >
          {/* The card's window has no title bar: the header moves it. */}
          <div class="user-card__hero" data-tauri-drag-region="deep">
            <Show
              when={profile()?.profile_image_url}
              fallback={
                <span class="user-card__avatar user-card__avatar--empty">
                  {u().display_name.slice(0, 1)}
                </span>
              }
            >
              {(url) => (
                <>
                  <button
                    type="button"
                    class="user-card__avatar-btn"
                    aria-label="Show a bigger picture"
                    aria-expanded={bigAvatar()}
                    onClick={() => setBigAvatar((v) => !v)}
                  >
                    <img
                      class="user-card__avatar"
                      src={url()}
                      alt=""
                      width={36}
                      height={36}
                      draggable={false}
                    />
                  </button>
                  {/* Over the top of the card, the messages left in view. */}
                  <Show when={bigAvatar()}>
                    <button
                      type="button"
                      class="user-card__avatar-big"
                      aria-label="Close the picture"
                      onClick={() => setBigAvatar(false)}
                    >
                      <img src={url()} alt="" draggable={false} />
                    </button>
                  </Show>
                </>
              )}
            </Show>
            <div class="user-card__who">
              <Show
                when={u().platform_user_id !== currentUserId()}
                fallback={
                  <span class="user-card__name user-card__name--self">
                    {u().display_name}
                  </span>
                }
              >
                <span
                  class="user-card__name"
                  classList={{ "name--painted": name().painted }}
                  style={name().style}
                >
                  {u().display_name}
                </span>
              </Show>
              <Show when={u().username !== u().display_name.toLowerCase()}>
                <span class="user-card__login">{u().username}</span>
              </Show>
              <Show when={badges().length > 0}>
                <div class="user-card__badges">
                  <For each={badges()}>
                    {(b) => (
                      <img
                        class="user-card__badge"
                        src={b.url_2x || b.url_1x}
                        alt={b.title}
                        title={b.title}
                        width={16}
                        height={16}
                        draggable={false}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <Show when={props.controls}>
              <div class="user-card__controls">{props.controls}</div>
            </Show>
          </div>

          <Show when={profile()?.description}>
            {(d) => {
              let ref: HTMLParagraphElement | undefined;
              // Only a bio cut short by the clamp opens on a click.
              const [long, setLong] = createSignal(false);
              createEffect(() => {
                d();
                if (ref && !bioOpen()) {
                  setLong(ref.scrollHeight > ref.clientHeight);
                }
              });
              const toggle = () => {
                if (long()) setBioOpen((v) => !v);
              };
              return (
                <p
                  ref={(el) => (ref = el)}
                  class="user-card__bio"
                  classList={{
                    "user-card__bio--long": long(),
                    "user-card__bio--open": bioOpen(),
                  }}
                  role={long() ? "button" : undefined}
                  tabIndex={long() ? 0 : undefined}
                  aria-expanded={long() ? bioOpen() : undefined}
                  onClick={() => {
                    if (!window.getSelection()?.toString()) toggle();
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    toggle();
                  }}
                >
                  {d()}
                </p>
              );
            }}
          </Show>

          <dl class="user-card__stats">
            <Show when={profile()}>
              {(p) => (
                <div
                  classList={{
                    "user-card__stat": true,
                    "user-card__stat--warn": isNewAccount(p(), Date.now()),
                  }}
                >
                  <dt>Account</dt>
                  <dd>{formatJoined(p().created_at, Date.now())}</dd>
                </div>
              )}
            </Show>
            <Show when={followers.state === "ready" ? followers() : null}>
              {(n) => (
                <div class="user-card__stat">
                  <dt>Followers</dt>
                  <dd>{formatViewers(n())}</dd>
                </div>
              )}
            </Show>
            <Show when={followedAt()}>
              {(since) => (
                <div class="user-card__stat">
                  <dt>Following</dt>
                  <dd>{capitalize(formatSince(since(), Date.now()))}</dd>
                </div>
              )}
            </Show>
            <Show when={history().length > 0}>
              <div class="user-card__stat">
                <dt>Mod actions</dt>
                <dd>{history().length}</dd>
              </div>
            </Show>
            <div class="user-card__stat">
              <dt>ID</dt>
              <dd>
                <button
                  type="button"
                  class="user-card__copy"
                  classList={{ "user-card__copy--done": copied() }}
                  aria-label={`Copy user ID ${u().platform_user_id}`}
                  onClick={() => void copyId(u().platform_user_id)}
                >
                  {copied() ? "Copied" : u().platform_user_id}
                </button>
              </dd>
            </div>
          </dl>

          <Show when={sub()}>
            {(line) => (
              <p
                class="user-card__sub"
                classList={{ "user-card__sub--current": line().current }}
              >
                {line().text}
              </p>
            )}
          </Show>

          {/* Mention, highlight and ignore are about someone else. */}
          <Show when={!isSelf()}>
            <div class="user-card__actions">
              <button
                type="button"
                class="user-card__action"
                onClick={() => {
                  props.onMention(u().username);
                  close();
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="2.6"
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                  <path
                    d="M10.6 8v1.2a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
                Mention
              </button>
              <button
                type="button"
                class="user-card__action"
                aria-pressed={spotlit()}
                onClick={() =>
                  void setUserHighlighted(u().username, !spotlit()).catch(
                    (err: unknown) => console.error("highlight user", err),
                  )
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                    fill={spotlit() ? "currentColor" : "none"}
                  />
                </svg>
                {spotlit() ? "Stop highlighting" : "Highlight"}
              </button>
              <button
                type="button"
                class="user-card__action"
                aria-pressed={ignored()}
                onClick={() =>
                  void setIgnored(u().username, !ignored()).catch(
                    (err: unknown) => console.error("ignore", err),
                  )
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="5.8"
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                  <path
                    d="M4 4l8 8"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
                {ignored() ? "Unignore" : "Ignore"}
              </button>
              <button
                type="button"
                class="user-card__action"
                onClick={() =>
                  void openUrl(`https://www.twitch.tv/${u().username}`).catch(
                    (err: unknown) => console.error("open profile", err),
                  )
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5 7.5 8.5"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                Twitch
              </button>
            </div>
          </Show>

          <Show when={moderationNeedsReconnect()}>
            <div class="user-card__note">
              Moderation needs new Twitch permissions. Reconnect in Settings.
            </div>
          </Show>
          <Show when={moderates() && canTarget()}>
            <div class="user-card__mod">
              <div class="user-card__mod-row">
                <button
                  type="button"
                  class="btn btn--small"
                  disabled={busy()}
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
                <div class="segmented" role="group" aria-label="Timeout">
                  <For each={CARD_TIMEOUTS}>
                    {(seconds) => (
                      <button
                        type="button"
                        class="segmented__btn"
                        disabled={busy()}
                        title={`Time out for ${formatSeconds(seconds)}`}
                        onClick={() =>
                          void runMod(
                            "timeout",
                            () =>
                              timeoutUser(
                                u().channel_id,
                                u().platform_user_id,
                                seconds,
                                undefined,
                              ),
                            `Timed out ${u().display_name} for ${formatSeconds(seconds)}.`,
                          )
                        }
                      >
                        {formatSeconds(seconds)}
                      </button>
                    )}
                  </For>
                </div>
                <span class="user-card__mod-end">
                  <Show
                    when={pending() === "confirm_ban"}
                    fallback={
                      <button
                        type="button"
                        class="btn btn--small btn--danger"
                        disabled={busy()}
                        onClick={() => setPending("confirm_ban")}
                      >
                        Ban
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="btn btn--small btn--danger btn--armed"
                      onClick={() =>
                        void runMod(
                          "ban",
                          () =>
                            banUser(
                              u().channel_id,
                              u().platform_user_id,
                              undefined,
                            ),
                          `Banned ${u().display_name}.`,
                        )
                      }
                    >
                      Confirm ban
                    </button>
                  </Show>
                </span>
              </div>
            </div>
          </Show>

          <Show when={notice()}>
            {(n) => (
              <div class="user-card__notice" role="status">
                {n()}
              </div>
            )}
          </Show>

          <div class="user-card__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              class="user-card__tab"
              aria-selected={tab() === "messages"}
              onClick={() => setTab("messages")}
            >
              Messages
              <span class="user-card__tab-count">{recent().length}</span>
            </button>
            <Show when={history().length > 0}>
              <button
                type="button"
                role="tab"
                class="user-card__tab"
                aria-selected={tab() === "history"}
                onClick={() => setTab("history")}
              >
                Mod history
                <span class="user-card__tab-count">{history().length}</span>
              </button>
            </Show>
          </div>

          <div
            ref={(el) => (listRef = el)}
            class="palette__body user-card__list"
            role="tabpanel"
            onScroll={(e) => {
              const el = e.currentTarget;
              atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            <Show when={tab() === "history" && history().length > 0}>
              <For each={history()}>
                {(a) => (
                  <div class="user-card__history-row">
                    <span class="msg-row__time">
                      {formatTimestamp(a.timestamp)}
                    </span>
                    <span>{describeModAction(a)}</span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={tab() === "messages" || history().length === 0}>
              <Show
                when={recent().length > 0}
                fallback={
                  <div class="palette__empty palette__empty--center">
                    Nothing from {u().display_name} in this session yet.
                  </div>
                }
              >
                <ol class="card-lines">
                  <For each={recent()}>
                    {(m) => (
                      <li
                        class="card-line"
                        classList={{
                          "card-line--deleted": m.deleted === true,
                          "card-line--mention": isHighlighted(
                            m.message_text,
                            props.login,
                            settings().highlightPhrases,
                          ),
                        }}
                        onContextMenu={(e) =>
                          openContextMenu(e, [
                            item("Jump to message", () => {
                              close();
                              props.onJump(m);
                            }),
                            item(
                              "Copy message",
                              () =>
                                void navigator.clipboard
                                  .writeText(m.message_text)
                                  .catch((err: unknown) =>
                                    console.error("copy message", err),
                                  ),
                            ),
                            ...(moderates() && !m.deleted
                              ? [
                                  separator,
                                  item(
                                    "Delete message",
                                    () =>
                                      void runMod(
                                        "delete",
                                        async () => {
                                          await deleteMessage(
                                            m.channel_id,
                                            m.id,
                                          );
                                          props.chat.markDeleted(m.id);
                                        },
                                        "Message deleted.",
                                      ),
                                    true,
                                  ),
                                ]
                              : []),
                          ])
                        }
                      >
                        <span class="card-line__time">
                          {formatTimestamp(m.timestamp)}
                        </span>
                        <For each={lineBadges(m)}>
                          {(b) => (
                            <img
                              class="card-line__badge"
                              src={b.url_1x}
                              alt={b.title}
                              width={14}
                              height={14}
                              draggable={false}
                            />
                          )}
                        </For>
                        <Show
                          when={m.notice}
                          fallback={
                            <>
                              <span
                                class="card-line__name"
                                classList={{ "name--painted": name().painted }}
                                style={name().style}
                              >
                                {m.display_name}
                              </span>
                              <span class="card-line__sep">: </span>
                            </>
                          }
                        >
                          {(n) => (
                            <span class="card-line__notice">
                              {n().system_message}{" "}
                            </span>
                          )}
                        </Show>
                        <MessagePieces
                          pieces={splitMessage(m.message_text, m.emote_spans, {
                            maxHeight: CARD_LINE_HEIGHT,
                          })}
                        />
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </Show>
          </div>
        </main>
      )}
    </Show>
  );
};

export default UserCard;
