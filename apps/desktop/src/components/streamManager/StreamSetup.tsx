// What viewers see in the directory: title, category, tags, language,
// content labels and branded content. Edits stay local until Save, only
// the fields that changed are sent, and the form then shows whatever
// Twitch answers with.

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  LIMITS,
  STREAM_LANGUAGES,
  labelChanges,
  labelLocale,
  type ChannelInfo,
  type ChannelInfoUpdate,
} from "../../lib/streamManager";
import { formatChannelError } from "../../lib/twitchChannel";
import {
  channelInfoError,
  channelInfoPending,
  contentLabels,
  contentLabelsError,
  loadContentLabels,
  streamChannelInfo,
  streamManagerLoading,
  updateChannelInfo,
} from "../../stores/streamManagerStore";
import CategoryPicker, { type PickedCategory } from "./CategoryPicker";
import TagField from "./TagField";

// Twitch sets this one from the category; it cannot be switched by hand.
const CATEGORY_LABEL = "MatureGame";

const languageNames = new Intl.DisplayNames(navigator.languages, {
  type: "language",
});

function languageName(code: string): string {
  if (code === "other") return "Other";
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const LANGUAGES = STREAM_LANGUAGES.map((code) => ({
  code,
  name: languageName(code),
})).sort((a, b) => a.name.localeCompare(b.name));

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const StreamSetup: Component = () => {
  const [title, setTitle] = createSignal("");
  const [category, setCategory] = createSignal<PickedCategory>({
    id: "",
    name: "",
  });
  const [tags, setTags] = createSignal<string[]>([]);
  const [language, setLanguage] = createSignal("");
  const [labels, setLabels] = createSignal<string[]>([]);
  const [branded, setBranded] = createSignal(false);
  const [editLabels, setEditLabels] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  const reset = (info: ChannelInfo) => {
    setTitle(info.title);
    setCategory({ id: info.game_id, name: info.game_name });
    setTags(info.tags);
    setLanguage(info.broadcaster_language);
    setLabels(info.content_classification_labels);
    setBranded(info.is_branded_content);
  };
  createEffect(on(streamChannelInfo, (info) => info && reset(info)));

  onMount(() => {
    if (contentLabels().length === 0) {
      void loadContentLabels(labelLocale(navigator.languages));
    }
  });

  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(savedTimer));

  const changes = (): ChannelInfoUpdate | null => {
    const info = streamChannelInfo();
    if (!info) return null;
    const update: ChannelInfoUpdate = {};
    const t = title().trim();
    if (t !== info.title) update.title = t;
    if (category().id !== info.game_id) update.game_id = category().id;
    if (!sameList(tags(), info.tags)) update.tags = tags();
    if (language() !== info.broadcaster_language)
      update.broadcaster_language = language();
    const labelUpdate = labelChanges(
      info.content_classification_labels,
      labels(),
    );
    if (labelUpdate) update.content_classification_labels = labelUpdate;
    if (branded() !== info.is_branded_content)
      update.is_branded_content = branded();
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

  // A language Twitch has on the channel but the list lacks stays pickable.
  const languages = () =>
    !language() || LANGUAGES.some((l) => l.code === language())
      ? LANGUAGES
      : [{ code: language(), name: languageName(language()) }, ...LANGUAGES];

  const labelName = (id: string) =>
    contentLabels().find((l) => l.id === id)?.name ?? id;

  const toggleLabel = (id: string, on: boolean) =>
    setLabels((list) => (on ? [...list, id] : list.filter((l) => l !== id)));

  return (
    <section class="sm-setup" aria-labelledby="sm-setup-title">
      <div class="sm-heading">
        <h2 id="sm-setup-title">Stream setup</h2>
        <span class="sm-hint">What viewers see in the directory</span>
      </div>
      <Show
        when={streamChannelInfo()}
        fallback={
          <div class="sm-hint">
            {streamManagerLoading() || !channelInfoError()
              ? "Loading your stream"
              : formatChannelError(channelInfoError())}
          </div>
        }
      >
        <div class="sm-field">
          <label class="sm-label" for="sm-title">
            Title
            <span
              class="sm-label__aside"
              classList={{
                "sm-label__aside--full": title().length >= LIMITS.titleChars,
              }}
            >
              {LIMITS.titleChars - title().length} left
            </span>
          </label>
          <textarea
            id="sm-title"
            class="sm-input sm-input--area"
            rows="2"
            maxLength={LIMITS.titleChars}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>

        <CategoryPicker value={category()} onPick={setCategory} />
        <TagField tags={tags()} onChange={setTags} />

        <div class="sm-row">
          <div class="sm-field sm-field--narrow">
            <label class="sm-label" for="sm-language">
              Language
            </label>
            <select
              id="sm-language"
              class="sm-input"
              onChange={(e) => setLanguage(e.currentTarget.value)}
            >
              <For each={languages()}>
                {(l) => (
                  <option value={l.code} selected={l.code === language()}>
                    {l.name}
                  </option>
                )}
              </For>
            </select>
          </div>
          <div class="sm-field sm-field--wide">
            <span class="sm-label" id="sm-labels">
              Content labels
            </span>
            <div class="sm-labels" role="group" aria-labelledby="sm-labels">
              <span class="sm-labels__list">
                {labels().length > 0
                  ? labels().map(labelName).join(", ")
                  : "None"}
              </span>
              <button
                type="button"
                class="sm-link"
                aria-expanded={editLabels()}
                onClick={() => setEditLabels((v) => !v)}
              >
                {editLabels() ? "Done" : "Edit"}
              </button>
            </div>
          </div>
        </div>
        <Show when={editLabels()}>
          <Show
            when={contentLabels().length > 0}
            fallback={
              <div class="sm-hint">
                {contentLabelsError()
                  ? formatChannelError(contentLabelsError())
                  : "Loading labels"}
              </div>
            }
          >
            <ul class="sm-checks">
              <For each={contentLabels()}>
                {(l) => (
                  <li>
                    <label class="sm-check">
                      <input
                        type="checkbox"
                        checked={labels().includes(l.id)}
                        disabled={l.id === CATEGORY_LABEL}
                        onChange={(e) =>
                          toggleLabel(l.id, e.currentTarget.checked)
                        }
                      />
                      <span class="sm-check__text">
                        <span>{l.name}</span>
                        <span class="sm-hint">
                          {l.id === CATEGORY_LABEL
                            ? "Set by your category"
                            : l.description}
                        </span>
                      </span>
                    </label>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>

        <label class="sm-toggle">
          <input
            type="checkbox"
            class="switch"
            role="switch"
            checked={branded()}
            onChange={(e) => setBranded(e.currentTarget.checked)}
          />
          <span class="sm-toggle__text">
            <span>Branded content</span>
            <span class="sm-hint">
              Turn on when a sponsor paid for this stream
            </span>
          </span>
        </label>

        <div class="sm-actions">
          <button
            type="button"
            class="btn btn--small btn--primary"
            disabled={!changes() || channelInfoPending()}
            onClick={() => void save()}
          >
            {channelInfoPending() ? "Saving" : "Save changes"}
          </button>
          <button
            type="button"
            class="btn btn--small"
            disabled={!changes() || channelInfoPending()}
            onClick={() => {
              const info = streamChannelInfo();
              if (info) reset(info);
            }}
          >
            Discard
          </button>
          <Show when={saved()}>
            <span class="sm-saved" role="status">
              Saved
            </span>
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
    </section>
  );
};

export default StreamSetup;
