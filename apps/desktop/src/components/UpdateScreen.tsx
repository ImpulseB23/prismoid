// Full-window update screen: the download, the install and the restart
// happen behind it, so the installer never shows a window of its own.

import { Component, Show } from "solid-js";
import logo from "../assets/logo.svg";
import type { UpdateState } from "../stores/updateStore";

export interface ScreenView {
  title: string;
  detail: string;
  /** 0 to 100, or null while the size is unknown. */
  progress: number | null;
  failed: boolean;
}

export function screenFor(state: UpdateState): ScreenView | null {
  switch (state.kind) {
    case "downloading": {
      const progress = state.total
        ? Math.round((state.received / state.total) * 100)
        : null;
      return {
        title: `Updating to ${state.version}`,
        detail: progress === null ? "Downloading" : `Downloading ${progress}%`,
        progress,
        failed: false,
      };
    }
    case "ready":
      return {
        title: `Updating to ${state.version}`,
        detail: "Restarting",
        progress: 100,
        failed: false,
      };
    case "error":
      return state.during === "install"
        ? {
            title: "The update did not finish",
            detail: state.message,
            progress: null,
            failed: true,
          }
        : null;
    default:
      return null;
  }
}

export interface UpdateScreenProps {
  state: () => UpdateState;
  onRetry: () => void;
  onDismiss: () => void;
}

const UpdateScreen: Component<UpdateScreenProps> = (props) => (
  <Show when={screenFor(props.state())}>
    {(view) => (
      <div
        class="update-screen"
        classList={{ "update-screen--error": view().failed }}
        role={view().failed ? "alert" : "status"}
      >
        <img src={logo} alt="" />
        <h1>{view().title}</h1>
        <p>{view().detail}</p>
        <Show when={!view().failed}>
          <div
            class="update-screen__bar"
            classList={{ "update-screen__bar--busy": view().progress === null }}
          >
            <div style={{ width: `${view().progress ?? 30}%` }} />
          </div>
        </Show>
        <Show when={view().failed}>
          <div class="update-screen__actions">
            <button
              type="button"
              class="btn btn--primary"
              onClick={() => props.onRetry()}
            >
              Try again
            </button>
            <button
              type="button"
              class="btn btn--outline"
              onClick={() => props.onDismiss()}
            >
              Not now
            </button>
          </div>
        </Show>
      </div>
    )}
  </Show>
);

export default UpdateScreen;
