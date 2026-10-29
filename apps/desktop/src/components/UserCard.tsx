// Opens when a username in the feed is clicked. Shows who they are, the
// badges they hold in this channel, what they said recently, and the
// actions a viewer or moderator can take on them.

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
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
import { isLight } from "../stores/themeStore";
import { resolveBadge, badgeRevision } from "../stores/badgeStore";
import {
  markMessageDeleted,
  messageRevision,
  recentMessagesByUser,
  viewport,
  type ChatMessage,
} from "../stores/chatStore";
import { requestMention } from "../stores/composerStore";
import {
  FOLLOWERS_SCOPE,
  currentUserId,
  missingScopes,
  moderationNeedsReconnect,
} from "../stores/authStore";
import { getFollowSince } from "../lib/twitchChannel";
import { modActionsFor, modLogRevision } from "../stores/modLogStore";
import { describeModAction } from "../lib/modActions";
import { formatSeconds } from "../lib/slashCommands";
import { canModerate } from "../stores/roleStore";
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
import MessageRow from "./MessageRow";
import TwitchReconnect from "./TwitchReconnect";
import { reconnectScopes } from "../stores/roleStore";
import { openSettings } from "../stores/settingsPanelStore";
import PaletteClose from "./PaletteClose";

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
  /** Signed-in login, so messages that mention it are highlighted. */
  login: string;
  onClose: () => void;
  onSignOut: () => void;
}

const RECENT_LIMIT = 20;

type Pending = "none" | "timeout" | "ban" | "confirm_ban" | "unban" | "delete";
type Tab = "messages" | "history";

const UserCard: Component<UserCardProps> = (props) => {
  const [pending, setPending] = createSignal<Pending>("none");
  const [notice, setNotice] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<Tab>("messages");
  // Free-text reason sent with the next timeout or ban. Twitch shows it to
  // other moderators, not to the chatter.
  const [reason, setReason] = createSignal("");
  let dialogRef: HTMLDivElement | undefined;

  const isSelf = () => props.user?.platform_user_id === currentUserId();

  // On your own card the actions are about your account, not a chatter.
  const AccountActions = () => (
    <>
      <Show when={reconnectScopes().length > 0}>
        <div class="user-card__reconnect">
          <TwitchReconnect
            title="Twitch needs new permissions"
            hint="Reconnect once to turn on what was added since you signed in."
          />
        </div>
      </Show>
      <div class="user-card__actions user-card__actions--account">
        <button
          type="button"
          class="user-card__action"
          onClick={() => {
            openSettings("account");
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
              cy="5.5"
              r="2.7"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <path
              d="M2.8 14c.6-2.7 2.7-4.3 5.2-4.3s4.6 1.6 5.2 4.3"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
          Account settings
        </button>
        <button
          type="button"
          class="user-card__action"
          onClick={() => {
            close();
            props.onSignOut();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 2.5H3.5v11H6M10.5 5l3 3-3 3M13.3 8H6.5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Sign out
        </button>
      </div>
    </>
  );

  // A new person starts fresh: their messages, no leftover notice or reason.
  createEffect(
    on(
      () => props.user?.platform_user_id,
      (id) => {
        if (id === undefined) return;
        setTab("messages");
        setPending("none");
        setNotice(null);
        setReason("");
        queueMicrotask(() => dialogRef?.focus());
      },
    ),
  );

  const badges = createMemo(() => {
    badgeRevision();
    const u = props.user;
    if (!u) return [];
    return u.badges.flatMap((b) => {
      const r = resolveBadge(b.set_id, b.id);
      return r ? [r] : [];
    });
  });

  const name = createMemo(() => {
    const u = props.user;
    return nameStyle(
      u?.color,
      u ? shownPaint(u.platform_user_id) : undefined,
      isLight(),
    );
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

  // Twitch tells you your own follow, and anyone's in a channel you
  // moderate once the followers scope is granted; elsewhere it says nothing,
  // so the stat stays off rather than guessing.
  const [following] = createResource(
    () => {
      const u = props.user;
      if (!u) return false;
      const own = u.platform_user_id === currentUserId();
      const mod = canModerate() && !missingScopes().includes(FOLLOWERS_SCOPE);
      return own || mod ? ([u.channel_id, u.platform_user_id] as const) : false;
    },
    ([channel, user]) => getFollowSince(channel, user),
  );

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

  const busy = () => pending() !== "none" && pending() !== "confirm_ban";

  return (
    <Show when={props.user}>
      {(u) => (
        <div class="palette-backdrop" onMouseDown={close}>
          <div
            ref={(el) => (dialogRef = el)}
            tabIndex={-1}
            class="palette user-card"
            role="dialog"
            aria-modal="true"
            aria-label={`${u().display_name} profile`}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
          >
            <div class="user-card__hero">
              <Show
                when={profile()?.profile_image_url}
                fallback={
                  <span class="user-card__avatar user-card__avatar--empty">
                    {u().display_name.slice(0, 1)}
                  </span>
                }
              >
                {(url) => (
                  <img
                    class="user-card__avatar"
                    src={url()}
                    alt=""
                    width={64}
                    height={64}
                    draggable={false}
                  />
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
                          width={18}
                          height={18}
                          draggable={false}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <PaletteClose onClick={close} />
            </div>

            <Show when={profile()?.description}>
              {(d) => <p class="user-card__bio">{d()}</p>}
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
              <Show when={following.state === "ready"}>
                <div class="user-card__stat">
                  <dt>Following</dt>
                  <dd>
                    {following()
                      ? capitalize(formatSince(following()!, Date.now()))
                      : "Not following"}
                  </dd>
                </div>
              </Show>
              <Show when={history().length > 0}>
                <div class="user-card__stat">
                  <dt>Mod actions</dt>
                  <dd>{history().length}</dd>
                </div>
              </Show>
            </dl>

            <Show when={!isSelf()} fallback={<AccountActions />}>
              <div class="user-card__actions">
                <button
                  type="button"
                  class="user-card__action"
                  onClick={() => {
                    requestMention(u().username);
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
            <Show when={canModerate()}>
              <div class="user-card__mod">
                <input
                  type="text"
                  class="settings__input user-card__reason"
                  placeholder="Reason (other mods see it)"
                  value={reason()}
                  onInput={(e) => setReason(e.currentTarget.value)}
                />
                <div class="user-card__mod-row">
                  <div class="segmented" role="group" aria-label="Timeout">
                    <For each={settings().timeoutPresets}>
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
                  </div>
                  <span class="user-card__mod-end">
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
                                reason().trim() || undefined,
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

            <div class="palette__body user-card__list" role="tabpanel">
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
                  <ol class="msg-list">
                    <For each={recent()}>
                      {(m) => (
                        <MessageRow
                          msg={m}
                          hideName
                          mention={isHighlighted(
                            m.message_text,
                            props.login,
                            settings().highlightPhrases,
                          )}
                          trailing={
                            <Show when={!m.deleted && canModerate()}>
                              <button
                                type="button"
                                class="msg-row__delete"
                                title="Delete message"
                                aria-label="Delete message"
                                disabled={busy()}
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
                          }
                        />
                      )}
                    </For>
                  </ol>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default UserCard;
