// Title and category for the user's own channel, the first card of the
// stream manager's Live section. Only the fields that changed are sent,
// and the form shows whatever Twitch answers with afterwards.

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { LIMITS, type Category } from "../../lib/streamManager";
import { formatChannelError } from "../../lib/twitchChannel";
import {
  currentUserId,
  streamManagerNeedsReconnect,
} from "../../stores/authStore";
import {
  categoryResults,
  categorySearchError,
  categorySearching,
  channelInfoError,
  channelInfoPending,
  clearStreamManager,
  loadStreamManager,
  searchCategories,
  streamChannelInfo,
  streamManagerLoading,
  updateChannelInfo,
} from "../../stores/streamManagerStore";

const boxArt = (c: Category) =>
  c.box_art_url.replace("{width}", "52").replace("{height}", "72");

const StreamSetup: Component = () => {
  // Loads for the signed-in account, again after a reconnect adds the
  // permission, and drops the old account's data on a switch.
  createEffect(
    on(
      () => (streamManagerNeedsReconnect() ? null : currentUserId()),
      (owner) => {
        clearStreamManager();
        if (owner !== null) void loadStreamManager();
      },
    ),
  );

  const [title, setTitle] = createSignal("");
  // null means the category is unchanged; an empty id clears it.
  const [category, setCategory] = createSignal<Pick<
    Category,
    "id" | "name"
  > | null>(null);
  const [query, setQuery] = createSignal("");
  const [saved, setSaved] = createSignal(false);

  createEffect(
    on(streamChannelInfo, (info) => {
      if (!info) return;
      setTitle(info.title);
      setCategory(null);
    }),
  );

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(searchTimer);
    clearTimeout(savedTimer);
    void searchCategories("");
  });

  const onQuery = (q: string) => {
    setQuery(q);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void searchCategories(q), 250);
  };

  const pick = (c: Pick<Category, "id" | "name">) => {
    setCategory(c);
    setQuery("");
    void searchCategories("");
  };

  const changes = () => {
    const info = streamChannelInfo();
    if (!info) return null;
    const update: { title?: string; game_id?: string } = {};
    const t = title().trim();
    if (t !== info.title) update.title = t;
    const c = category();
    if (c && c.id !== info.game_id) update.game_id = c.id;
    return Object.keys(update).length > 0 ? update : null;
  };

  const save = async () => {
    const update = changes();
    if (!update) return;
    if (await updateChannelInfo(update)) {
      setSaved(true);
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => setSaved(false), 2000);
    }
  };

  const shownCategory = () =>
    category()?.name ?? streamChannelInfo()?.game_name ?? "";

  return (
    <section class="sm-card stream-info" aria-label="Stream setup">
      <h3 class="sm-card__title">Stream setup</h3>
      <Show
        when={!streamManagerNeedsReconnect()}
        fallback={
          <div class="dialog__error">
            Editing your stream needs a new Twitch permission. Reconnect Twitch
            in Prismoid's Settings, under Account.
          </div>
        }
      >
        <Show
          when={streamChannelInfo()}
          fallback={
            <div class="cc__empty">
              {streamManagerLoading() || !channelInfoError()
                ? "Loading"
                : formatChannelError(channelInfoError())}
            </div>
          }
        >
          <label class="stream-info__field">
            <span class="stream-info__label">
              Title
              <span
                class="stream-info__count"
                classList={{
                  "stream-info__count--full":
                    title().length >= LIMITS.titleChars,
                }}
              >
                {LIMITS.titleChars - title().length}
              </span>
            </span>
            <textarea
              class="settings__input stream-info__title"
              rows="2"
              maxLength={LIMITS.titleChars}
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>

          <div class="stream-info__field">
            <span class="stream-info__label">Category</span>
            <div class="stream-info__category">
              <span classList={{ "stream-info__none": !shownCategory() }}>
                {shownCategory() || "No category"}
              </span>
              <Show when={shownCategory()}>
                <button
                  type="button"
                  class="btn btn--small btn--outline"
                  onClick={() => pick({ id: "", name: "" })}
                >
                  Clear
                </button>
              </Show>
            </div>
            <input
              type="text"
              class="settings__input"
              placeholder="Search categories"
              aria-label="Search categories"
              value={query()}
              onInput={(e) => onQuery(e.currentTarget.value)}
            />
            <Show when={query().trim()}>
              <Show
                when={!categorySearchError()}
                fallback={
                  <div class="dialog__error">
                    {formatChannelError(categorySearchError())}
                  </div>
                }
              >
                <ul
                  class="stream-info__results"
                  aria-busy={categorySearching()}
                >
                  <For
                    each={categoryResults()}
                    fallback={
                      <li class="cc__empty">
                        {categorySearching() ? "Searching" : "No matches"}
                      </li>
                    }
                  >
                    {(c) => (
                      <li>
                        <button
                          type="button"
                          class="stream-info__result"
                          onClick={() => pick(c)}
                        >
                          <img src={boxArt(c)} alt="" width="26" height="36" />
                          <span>{c.name}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </div>

          <div class="stream-info__actions">
            <button
              type="button"
              class="btn btn--small btn--primary"
              disabled={!changes() || channelInfoPending()}
              onClick={() => void save()}
            >
              {channelInfoPending() ? "Saving" : "Save"}
            </button>
            <Show when={saved()}>
              <span class="stream-info__saved">Saved</span>
            </Show>
          </div>
          <Show when={channelInfoError()}>
            {(err) => (
              <div class="dialog__error" role="alert">
                {formatChannelError(err())}
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  );
};

export default StreamSetup;
