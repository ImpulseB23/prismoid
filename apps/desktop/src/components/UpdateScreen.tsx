// Full-window update screen: the download happens behind it, and the
// update splash window takes over with the same look once the app quits
// for the installer.

import { Component, Show } from "solid-js";
import { logo } from "../stores/themeStore";
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
        title: "Updating prismoid",
        detail: progress === null ? "Downloading" : `Downloading ${progress}%`,
        progress,
        failed: false,
      };
    }
    case "ready":
      return {
        title: "Updating prismoid",
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

export const UpdateView: Component<{
  view: ScreenView;
  logo: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}> = (props) => (
  <div
    class="update-screen"
    classList={{ "update-screen--error": props.view.failed }}
    role={props.view.failed ? "alert" : "status"}
  >
    <img src={props.logo} alt="" />
    <h1>{props.view.title}</h1>
    <p>{props.view.detail}</p>
    <Show when={!props.view.failed}>
      <div
        class="update-screen__bar"
        classList={{ "update-screen__bar--busy": props.view.progress === null }}
      >
        <div style={{ width: `${props.view.progress ?? 30}%` }} />
      </div>
    </Show>
    <Show when={props.view.failed}>
      <div class="update-screen__actions">
        <button
          type="button"
          class="btn btn--primary"
          onClick={() => props.onRetry?.()}
        >
          Try again
        </button>
        <button
          type="button"
          class="btn btn--outline"
          onClick={() => props.onDismiss?.()}
        >
          Not now
        </button>
      </div>
    </Show>
  </div>
);

const UpdateScreen: Component<UpdateScreenProps> = (props) => (
  <Show when={screenFor(props.state())}>
    {(view) => (
      <UpdateView
        view={view()}
        logo={logo()}
        onRetry={props.onRetry}
        onDismiss={props.onDismiss}
      />
    )}
  </Show>
);

export default UpdateScreen;
