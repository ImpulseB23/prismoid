// Stream tags as removable chips with a field to add more. Enter or a
// comma adds what was typed; Backspace in the empty field removes the last
// one. Same rules as the host: letters and numbers of any script.

import { Component, For, Show, createSignal } from "solid-js";
import { LIMITS } from "../../lib/streamManager";

// Rust's char::is_alphanumeric, which the host checks with.
const TAG_RE = /^[\p{Alphabetic}\p{N}]+$/u;

function problem(tag: string, tags: readonly string[]): string | null {
  if (!TAG_RE.test(tag)) return "Tags use letters and numbers only, no spaces.";
  if ([...tag].length > LIMITS.tagChars)
    return `Tags can be up to ${LIMITS.tagChars} characters.`;
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
    return `${tag} is already a tag.`;
  return null;
}

const TagField: Component<{
  tags: string[];
  onChange: (tags: string[]) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const full = () => props.tags.length >= LIMITS.tags;

  const add = () => {
    const tag = draft().trim();
    if (!tag) return;
    const why = problem(tag, props.tags);
    setError(why);
    if (why) return;
    props.onChange([...props.tags, tag]);
    setDraft("");
  };

  return (
    <div class="sm-field">
      <span class="sm-label" id="sm-tags">
        Tags
        <span class="sm-label__aside">
          {props.tags.length} of {LIMITS.tags}
        </span>
      </span>
      <div class="sm-tags" role="group" aria-labelledby="sm-tags">
        <For each={props.tags}>
          {(tag) => (
            <span class="sm-chip">
              {tag}
              <button
                type="button"
                class="sm-chip__remove"
                aria-label={`Remove ${tag}`}
                onClick={() =>
                  props.onChange(props.tags.filter((t) => t !== tag))
                }
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  aria-hidden="true"
                >
                  <path
                    d="M2 2l6 6M8 2 2 8"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </span>
          )}
        </For>
        <input
          type="text"
          class="sm-tags__input"
          aria-label="Add a tag"
          aria-describedby={error() ? "sm-tags-error" : undefined}
          placeholder={full() ? "All 10 used" : "Add a tag"}
          disabled={full()}
          value={draft()}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (
              e.key === "Backspace" &&
              draft() === "" &&
              props.tags.length > 0
            ) {
              props.onChange(props.tags.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      </div>
      <Show when={error()}>
        {(e) => (
          <span class="sm-hint sm-hint--error" id="sm-tags-error" role="alert">
            {e()}
          </span>
        )}
      </Show>
    </div>
  );
};

export default TagField;
