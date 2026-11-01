// The top bar's update button. It shows the moment an update is found
// rather than once the background download is done; clicking before then
// installs anyway, with the download showing on the update screen first.

import { Component, Show } from "solid-js";
import type { UpdateState } from "../stores/updateStore";
import { displayVersion } from "../lib/version";

const UpdateButton: Component<{
  state: UpdateState;
  onInstall: () => void;
}> = (props) => (
  <Show
    when={
      props.state.kind === "available" || props.state.kind === "downloaded"
        ? props.state
        : null
    }
  >
    {(u) => {
      const label = () =>
        u().kind === "downloaded"
          ? `Restart to update to ${displayVersion(u().version)}`
          : `Update to ${displayVersion(u().version)}`;
      return (
        <button
          type="button"
          class="icon-btn"
          title={label()}
          aria-label={label()}
          onClick={() => props.onInstall()}
        >
          <span class="header__update" aria-hidden="true" />
        </button>
      );
    }}
  </Show>
);

export default UpdateButton;
