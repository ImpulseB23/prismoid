// What's new in this version, Discord style: opens once after an update
// and again from Settings. The full changelog stays one click away.

import { Component, For, Show, createEffect } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { displayVersion } from "../lib/version";
import {
  closePatchNotes,
  patchNotes,
  releaseNotesUrl,
} from "../stores/whatsNewStore";

const PatchNotes: Component = () => {
  let dialogRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (patchNotes()) queueMicrotask(() => dialogRef?.focus());
  });

  return (
    <Show when={patchNotes()}>
      {(n) => (
        <div class="dialog-backdrop" onMouseDown={closePatchNotes}>
          <div
            ref={(el) => (dialogRef = el)}
            tabIndex={-1}
            class="dialog notes"
            role="dialog"
            aria-modal="true"
            aria-label={`What's new in ${displayVersion(n().version)}`}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") closePatchNotes();
            }}
          >
            <div class="notes__hero">
              <span class="notes__version">
                What's new in {displayVersion(n().version)}
              </span>
              <h2 class="notes__headline">{n().headline}</h2>
            </div>
            <ul class="notes__features">
              <For each={n().features}>
                {(f) => (
                  <li class="notes__feature">
                    <span class="notes__title">{f.title}</span>
                    <span class="notes__body">{f.body}</span>
                  </li>
                )}
              </For>
            </ul>
            <Show when={n().fixes.length > 0}>
              <div class="dialog__label">Also in this update</div>
              <ul class="notes__fixes">
                <For each={n().fixes}>{(f) => <li>{f}</li>}</For>
              </ul>
            </Show>
            <div class="notes__actions">
              <button
                type="button"
                class="btn btn--outline"
                onClick={() =>
                  void openUrl(releaseNotesUrl(n().version)).catch(
                    (err: unknown) => console.error("release notes", err),
                  )
                }
              >
                Full changelog
              </button>
              <button
                type="button"
                class="btn btn--primary"
                onClick={closePatchNotes}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default PatchNotes;
