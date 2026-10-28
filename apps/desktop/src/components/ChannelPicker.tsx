// Command-palette style channel switcher. With nothing typed it lists the
// followed channels that are live, then recents. Recents match instantly;
// after a short pause the query also goes to Helix search so any channel on
// Twitch shows up with its live state. Enter on free text still resolves an
// exact login, which covers channels Helix search leaves out (no stream in
// six months).

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
  formatChannelError,
  getFollowedLive,
  normalizeLogin,
  searchChannels,
  type ChannelSearchResult,
  type FollowedLive,
} from "../lib/twitchChannel";
import { formatViewers } from "../lib/streamInfo";
import { missingScopes } from "../stores/authStore";
import {
  forgetRecentChannel,
  recentChannels,
  selectChannel,
  type RecentChannel,
} from "../stores/channelStore";
import {
  ensureUserInfo,
  userInfo,
  userInfoRevision,
} from "../stores/userInfoStore";

export interface ChannelPickerProps {
  open: boolean;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;

type LiveState = "idle" | "loading" | "ready" | "needs_scope" | "failed";

type Row =
  | { kind: "live"; channel: FollowedLive }
  | { kind: "recent"; channel: RecentChannel }
  | { kind: "search"; channel: ChannelSearchResult };

const ChannelPicker: Component<ChannelPickerProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(-1);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [results, setResults] = createSignal<ChannelSearchResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [live, setLive] = createSignal<FollowedLive[]>([]);
  const [liveState, setLiveState] = createSignal<LiveState>("idle");
  let inputRef: HTMLInputElement | undefined;
  let searchSeq = 0;
  let liveSeq = 0;

  const typed = () => query().trim().length > 0;
  const showLive = () =>
    !typed() && (liveState() === "ready" || liveState() === "needs_scope");
  const liveRows = createMemo(() => (typed() ? [] : live()));

  const recents = createMemo(() => {
    const q = query().trim().toLowerCase().replace(/^@/, "");
    const all = recentChannels();
    if (!q) {
      const shown = new Set(liveRows().map((c) => c.login));
      return all.filter((r) => !shown.has(r.login));
    }
    return all.filter(
      (r) => r.login.includes(q) || r.display_name.toLowerCase().includes(q),
    );
  });

  const rows = createMemo<Row[]>(() => {
    const seen = new Set(recents().map((r) => r.login));
    return [
      ...liveRows().map((channel): Row => ({ kind: "live", channel })),
      ...recents().map((channel): Row => ({ kind: "recent", channel })),
      ...results()
        .filter((c) => !seen.has(c.login))
        .map((channel): Row => ({ kind: "search", channel })),
    ];
  });

  // Fetched on every open since live state goes stale quickly. A grant
  // without the follows scope gets a reconnect hint instead of a call
  // that would fail.
  createEffect(
    on(
      () => props.open,
      (open) => {
        const seq = ++liveSeq;
        setLive([]);
        if (!open) {
          setLiveState("idle");
          return;
        }
        if (missingScopes().includes("user:read:follows")) {
          setLiveState("needs_scope");
          return;
        }
        setLiveState("loading");
        getFollowedLive().then(
          (found) => {
            if (seq !== liveSeq) return;
            ensureUserInfo(found.map((c) => c.id));
            setLive(found);
            setLiveState("ready");
          },
          (e: unknown) => {
            if (seq !== liveSeq) return;
            setLiveState("failed");
            console.error("followed live", e);
          },
        );
      },
    ),
  );

  // Debounced Helix search. A sequence number drops responses that come
  // back after the query moved on.
  createEffect(
    on(query, (q) => {
      const term = q.trim().replace(/^@/, "");
      const seq = ++searchSeq;
      if (!props.open || term.length === 0) {
        setResults([]);
        setSearching(false);
        return;
      }
      const timer = setTimeout(() => {
        setSearching(true);
        searchChannels(term).then(
          (found) => {
            if (seq !== searchSeq) return;
            setResults(found);
            setSearching(false);
          },
          (e: unknown) => {
            if (seq !== searchSeq) return;
            setSearching(false);
            console.error("channel search", e);
          },
        );
      }, SEARCH_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );

  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setHighlight(-1);
    setError(null);
    setBusy(false);
    setResults([]);
    queueMicrotask(() => inputRef?.focus());
  });

  const submit = async (raw: string) => {
    const login = normalizeLogin(raw);
    if (!login) {
      setError(formatChannelError({ kind: "invalid_login" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await selectChannel(login);
      props.onClose();
    } catch (e) {
      setError(formatChannelError(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = rows().length;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        props.onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (n > 0) setHighlight((h) => (h + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (n > 0) setHighlight((h) => (h <= 0 ? n - 1 : h - 1));
        break;
      case "Enter": {
        e.preventDefault();
        if (busy()) return;
        const h = highlight();
        const picked = h >= 0 ? rows()[h] : undefined;
        void submit(picked ? picked.channel.login : query());
        break;
      }
    }
  };

  const subline = (row: Row): string => {
    if (row.kind === "recent") return row.channel.login;
    if (row.kind === "live") {
      const c = row.channel;
      return [`${formatViewers(c.viewer_count)} watching`, c.game_name]
        .filter(Boolean)
        .join(" · ");
    }
    const c = row.channel;
    const parts = [
      c.followers !== null ? `${formatViewers(c.followers)} followers` : "",
      c.is_live && c.viewer_count !== null
        ? `${formatViewers(c.viewer_count)} watching`
        : "",
      c.is_live ? c.game_name : "",
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : c.login;
  };

  const avatar = (row: Row): string => {
    if (row.kind !== "live") return row.channel.profile_image_url;
    userInfoRevision();
    return userInfo(row.channel.id)?.profile_image_url ?? "";
  };

  // The index is an accessor because recents render before the live list
  // lands and then shift down by its length.
  const item = (row: Row, index: () => number) => {
    const c = row.channel;
    const isLive =
      row.kind === "live" || (row.kind === "search" && row.channel.is_live);
    return (
      <div
        class="picker__item"
        role="option"
        aria-selected={highlight() === index()}
        onMouseEnter={() => setHighlight(index())}
        onClick={() => void submit(c.login)}
      >
        <Show
          when={avatar(row)}
          fallback={<span class="picker__item-avatar" />}
        >
          {(src) => <img class="picker__item-avatar" src={src()} alt="" />}
        </Show>
        <span class="picker__item-text">
          <span class="picker__item-name">
            {c.display_name}
            <Show when={row.kind === "search" && row.channel.followed}>
              <span class="picker__followed">following</span>
            </Show>
            <Show when={isLive}>
              <span class="picker__live">live</span>
            </Show>
          </span>
          <span class="picker__item-login">{subline(row)}</span>
        </span>
        <Show when={row.kind === "recent"}>
          <button
            type="button"
            title="Remove from recent"
            aria-label={`Remove ${c.display_name} from recent`}
            class="icon-btn icon-btn--small"
            onClick={(e) => {
              e.stopPropagation();
              forgetRecentChannel(c.login);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
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
    );
  };

  return (
    <Show when={props.open}>
      <div class="picker-backdrop" onMouseDown={() => props.onClose()}>
        <div
          class="picker"
          role="dialog"
          aria-modal="true"
          aria-label="Switch channel"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          <div class="picker__field">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="7"
                cy="7"
                r="4.5"
                stroke="currentColor"
                stroke-width="1.5"
              />
              <path
                d="m10.5 10.5 3 3"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <input
              ref={(el) => (inputRef = el)}
              class="picker__input"
              type="text"
              placeholder="Search Twitch channels"
              autocomplete="off"
              spellcheck={false}
              aria-label="Search Twitch channels"
              value={query()}
              disabled={busy()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setHighlight(-1);
                setError(null);
              }}
            />
            <Show
              when={busy() || searching()}
              fallback={<kbd aria-hidden="true">Esc</kbd>}
            >
              <span
                class="picker__spinner"
                aria-label={busy() ? "Connecting" : "Searching"}
              />
            </Show>
          </div>

          <div class="picker__section">
            <Show when={showLive()}>
              <div class="picker__label">Live now</div>
              <Show
                when={liveRows().length > 0}
                fallback={
                  <div class="picker__empty">
                    {liveState() === "needs_scope"
                      ? "Reconnect Twitch in Settings to see who you follow that's live."
                      : "Nobody you follow is live right now."}
                  </div>
                }
              >
                <For each={liveRows()}>
                  {(channel, i) => item({ kind: "live", channel }, i)}
                </For>
              </Show>
            </Show>
            <Show when={rows().length === 0 && !showLive()}>
              <div class="picker__empty">
                {typed()
                  ? searching()
                    ? "Searching Twitch"
                    : `Press Enter to open ${query().trim()}`
                  : "Channels you open will show up here."}
              </div>
            </Show>
            <Show when={recents().length > 0}>
              <div class="picker__label">Recent</div>
              <For each={recents()}>
                {(channel, i) =>
                  item(
                    { kind: "recent", channel },
                    () => i() + liveRows().length,
                  )
                }
              </For>
            </Show>
            <Show when={rows().length > liveRows().length + recents().length}>
              <div class="picker__label">Twitch</div>
              <For each={rows().slice(liveRows().length + recents().length)}>
                {(row, i) =>
                  item(row, () => i() + liveRows().length + recents().length)
                }
              </For>
            </Show>
          </div>

          <Show when={error()}>
            {(e) => (
              <div class="picker__error" role="alert">
                {e()}
              </div>
            )}
          </Show>

          <div class="picker__footer">
            <span>
              <kbd>↑↓</kbd>move
            </span>
            <span>
              <kbd>Enter</kbd>open
            </span>
            <span>
              <kbd>Esc</kbd>close
            </span>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ChannelPicker;
