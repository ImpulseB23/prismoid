// The stream's category with its box art, and a search to change it.
// Helix's channel info has no art, so the current category's art comes
// from a category search for its name, matched by id.

import {
  Component,
  For,
  Show,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  searchCategories as findCategories,
  type Category,
} from "../../lib/streamManager";
import { formatChannelError } from "../../lib/twitchChannel";
import {
  categoryResults,
  categorySearchError,
  categorySearching,
  searchCategories,
} from "../../stores/streamManagerStore";

const art = (url: string, w: number, h: number) =>
  url.replace("{width}", String(w)).replace("{height}", String(h));

/** An empty id means no category. */
export type PickedCategory = Pick<Category, "id" | "name"> & {
  box_art_url?: string;
};

const CategoryPicker: Component<{
  value: PickedCategory;
  onPick: (c: PickedCategory) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  const [found] = createResource(
    () =>
      props.value.id && !props.value.box_art_url
        ? { id: props.value.id, name: props.value.name }
        : null,
    async ({ id, name }) => {
      try {
        const list = await findCategories(name);
        return list.find((c) => c.id === id)?.box_art_url ?? null;
      } catch (e) {
        console.error("category art", e);
        return null;
      }
    },
  );
  const boxArt = () =>
    props.value.box_art_url || (props.value.id ? found() : null) || null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(timer);
    void searchCategories("");
  });

  const onQuery = (q: string) => {
    setQuery(q);
    clearTimeout(timer);
    timer = setTimeout(() => void searchCategories(q), 250);
  };

  const close = () => {
    clearTimeout(timer);
    setOpen(false);
    setQuery("");
    void searchCategories("");
  };

  const pick = (c: PickedCategory) => {
    props.onPick(c);
    close();
  };

  return (
    <div class="sm-field">
      <span class="sm-label" id="sm-category">
        Category
      </span>
      <div class="sm-category" role="group" aria-labelledby="sm-category">
        <Show
          when={boxArt()}
          fallback={<span class="sm-category__art" aria-hidden="true" />}
        >
          {(url) => (
            <img
              class="sm-category__art"
              src={art(url(), 78, 104)}
              alt=""
              width="39"
              height="52"
            />
          )}
        </Show>
        <span
          class="sm-category__name"
          classList={{ "sm-category__name--none": !props.value.id }}
        >
          {props.value.id ? props.value.name : "No category"}
        </span>
        <Show when={props.value.id && !open()}>
          <button
            type="button"
            class="btn btn--small"
            onClick={() => pick({ id: "", name: "" })}
          >
            Remove
          </button>
        </Show>
        <button
          type="button"
          class="btn btn--small"
          aria-expanded={open()}
          onClick={() => {
            if (open()) return close();
            setOpen(true);
            inputRef?.focus();
          }}
        >
          {open() ? "Cancel" : "Change"}
        </button>
      </div>
      <Show when={open()}>
        <input
          type="text"
          class="sm-input"
          placeholder="Search categories"
          aria-label="Search categories"
          value={query()}
          ref={(el) => (inputRef = el)}
          onInput={(e) => onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        />
        <Show when={query().trim()}>
          <Show
            when={!categorySearchError()}
            fallback={
              <div class="dialog__error" role="alert">
                {formatChannelError(categorySearchError())}
              </div>
            }
          >
            <ul class="sm-results" aria-busy={categorySearching()}>
              <For
                each={categoryResults()}
                fallback={
                  <li class="sm-hint">
                    {categorySearching() ? "Searching" : "No matches"}
                  </li>
                }
              >
                {(c) => (
                  <li>
                    <button
                      type="button"
                      class="sm-results__item"
                      onClick={() => pick(c)}
                    >
                      <img
                        src={art(c.box_art_url, 52, 72)}
                        alt=""
                        width="26"
                        height="36"
                      />
                      <span>{c.name}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default CategoryPicker;
