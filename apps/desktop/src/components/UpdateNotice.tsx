// Update card for the sign-in screen, where Settings is out of reach. A bug
// that keeps someone from signing in gets fixed by the next release, so the
// install button has to be here too.

import { Component, Show } from "solid-js";
import type { UpdateState } from "../stores/updateStore";
import { displayVersion } from "../lib/version";

export interface Notice {
  text: string;
  action: string | null;
  error: boolean;
}

export function noticeFor(state: UpdateState): Notice | null {
  switch (state.kind) {
    case "available":
      return {
        text: `Version ${displayVersion(state.version)} is ready.`,
        action: "Install and restart",
        error: false,
      };
    case "downloading":
      return {
        text: state.total
          ? `Downloading ${Math.round((state.received / state.total) * 100)}%`
          : "Downloading",
        action: null,
        error: false,
      };
    case "ready":
      return {
        text: "Restarting to finish the update",
        action: null,
        error: false,
      };
    case "error":
      return { text: state.message, action: "Try again", error: true };
    default:
      return null;
  }
}

export interface UpdateNoticeProps {
  state: () => UpdateState;
  onInstall: () => void;
}

const UpdateNotice: Component<UpdateNoticeProps> = (props) => (
  <Show when={noticeFor(props.state())}>
    {(notice) => (
      <div
        class="update-notice"
        classList={{ "update-notice--error": notice().error }}
        role={notice().error ? "alert" : "status"}
      >
        <p>{notice().text}</p>
        <Show when={notice().action}>
          {(label) => (
            <button
              type="button"
              class="btn"
              classList={{
                "btn--primary": !notice().error,
                "btn--outline": notice().error,
              }}
              onClick={() => props.onInstall()}
            >
              {label()}
            </button>
          )}
        </Show>
      </div>
    )}
  </Show>
);

export default UpdateNotice;
