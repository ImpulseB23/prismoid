// Command-palette style channel switcher. With nothing typed it lists
// recents, then the followed channels that are live, the ones also in
// recents first. Recents match instantly;
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
  normalizeLogin,
  searchChannels,
  type ChannelSearchResult,
  type FollowedLive,
} from "../lib/twitchChannel";
import { formatViewers } from "../lib/streamInfo";
import {
  forgetRecentChannel,
  recentChannels,
  selectChannel,
  type RecentChannel,
} from "../stores/channelStore";
import { userInfo, userInfoRevision } from "../stores/userInfoStore";
import { followedLive, liveState } from "../stores/pickerStore";

export interface ChannelPickerProps {
  open: boolean;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;

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
  let inputRef: HTMLInputElement | undefined;
  let searchSeq = 0;

  const typed = () => query().trim().length > 0;
  const showLive = () =>
    !typed() && (liveState() === "ready" || liveState() === "needs_scope");
  const recents = createMemo(() => {
    const q = query().trim().toLowerCase().replace(/^@/, "");
    const all = recentChannels();
    if (!q) return all;
    return all.filter(
      (r) => r.login.includes(q) || r.display_name.toLowerCase().includes(q),
    );
  });

  const liveRows = createMemo(() => {
    if (typed()) return [];
    const rank = new Map(recentChannels().map((r, i) => [r.login, i]));
    const at = (c: FollowedLive) => rank.get(c.login) ?? rank.size;
    // Stable, so channels outside recents keep the host's order.
    return [...followedLive()].sort((a, b) => at(a) - at(b));
  });

  const rows = createMemo<Row[]>(() => {
    const seen = new Set(recents().map((r) => r.login));
    return [
      ...recents().map((channel): Row => ({ kind: "recent", channel })),
      ...liveRows().map((channel): Row => ({ kind: "live", channel })),
      ...results()
        .filter((c) => !seen.has(c.login))
        .map((channel): Row => ({ kind: "search", channel })),
    ];
  });

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
      await selectChannel(login, { remember: true });
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
        class="palette__item"
        role="option"
        aria-selected={highlight() === index()}
        onMouseEnter={() => setHighlight(index())}
        onClick={() => void submit(c.login)}
      >
        <Show
          when={avatar(row)}
          fallback={<span class="palette__item-avatar" />}
        >
          {(src) => <img class="palette__item-avatar" src={src()} alt="" />}
        </Show>
        <span class="palette__item-text">
          <span class="palette__item-name">
            {c.display_name}
            <Show when={row.kind === "search" && row.channel.followed}>
              <span class="palette__followed">following</span>
            </Show>
            <Show when={isLive}>
              <span class="palette__live">live</span>
            </Show>
          </span>
          <span class="palette__item-login">{subline(row)}</span>
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
      <div class="palette-backdrop" onMouseDown={() => props.onClose()}>
        <div
          class="palette"
          role="dialog"
          aria-modal="true"
          aria-label="Switch channel"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          <div class="palette__field">
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
              class="palette__input"
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
                class="palette__spinner"
                aria-label={busy() ? "Connecting" : "Searching"}
              />
            </Show>
          </div>

          <div class="palette__section">
            <Show when={recents().length > 0}>
              <div class="palette__label">Recent</div>
              <For each={recents()}>
                {(channel, i) => item({ kind: "recent", channel }, i)}
              </For>
            </Show>
            <Show when={showLive()}>
              <div class="palette__label">Live now</div>
              <Show
                when={liveRows().length > 0}
                fallback={
                  <div class="palette__empty">
                    {liveState() === "needs_scope"
                      ? "Reconnect Twitch in Settings to see who you follow that's live."
                      : "Nobody you follow is live right now."}
                  </div>
                }
              >
                <For each={liveRows()}>
                  {(channel, i) =>
                    item(
                      { kind: "live", channel },
                      () => i() + recents().length,
                    )
                  }
                </For>
              </Show>
            </Show>
            <Show when={rows().length === 0 && !showLive()}>
              <div class="palette__empty">
                {typed()
                  ? searching()
                    ? "Searching Twitch"
                    : `Press Enter to open ${query().trim()}`
                  : "Channels you open will show up here."}
              </div>
            </Show>
            <Show when={rows().length > liveRows().length + recents().length}>
              <div class="palette__label">Twitch</div>
              <For each={rows().slice(liveRows().length + recents().length)}>
                {(row, i) =>
                  item(row, () => i() + liveRows().length + recents().length)
                }
              </For>
            </Show>
          </div>

          <Show when={error()}>
            {(e) => (
              <div class="palette__error" role="alert">
                {e()}
              </div>
            )}
          </Show>

          <div class="palette__footer">
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
