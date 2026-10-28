// Minimize, maximize and close, drawn by the app when the native frame is
// off. Close goes through the normal close request, so close-to-tray
// still applies.

import { Component, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { customChrome, maximized } from "../stores/windowStore";

const report = (what: string) => (err: unknown) => console.error(what, err);

const WindowControls: Component = () => {
  const win = () => getCurrentWindow();
  return (
    <Show when={customChrome()}>
      <div class="window-controls">
        <button
          type="button"
          class="window-controls__btn"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => void win().minimize().catch(report("minimize"))}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" stroke-width="1.1" />
          </svg>
        </button>
        <button
          type="button"
          class="window-controls__btn"
          aria-label={maximized() ? "Restore" : "Maximize"}
          title={maximized() ? "Restore" : "Maximize"}
          onClick={() =>
            void win().toggleMaximize().catch(report("toggle maximize"))
          }
        >
          <Show
            when={maximized()}
            fallback={
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden="true"
              >
                <rect
                  x="0.5"
                  y="0.5"
                  width="9"
                  height="9"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.1"
                />
              </svg>
            }
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.1"
              />
            </svg>
          </Show>
        </button>
        <button
          type="button"
          class="window-controls__btn window-controls__btn--close"
          aria-label="Close"
          title="Close"
          onClick={() => void win().close().catch(report("close"))}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M0 0l10 10M10 0L0 10"
              stroke="currentColor"
              stroke-width="1.1"
            />
          </svg>
        </button>
      </div>
    </Show>
  );
};

export default WindowControls;
