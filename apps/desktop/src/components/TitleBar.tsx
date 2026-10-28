// A bare draggable strip with the window buttons, for the screens that have
// no header (splash, sign-in, the update screen).

import { Component, Show } from "solid-js";
import { customChrome } from "../stores/windowStore";
import WindowControls from "./WindowControls";

const TitleBar: Component = () => (
  <Show when={customChrome()}>
    <div class="titlebar" data-tauri-drag-region>
      <WindowControls />
    </div>
  </Show>
);

export default TitleBar;
