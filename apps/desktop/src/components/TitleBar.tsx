// A bare draggable strip with the window buttons, for the screens that have
// no header (splash, sign-in, the update screen). Slides away in fullscreen
// like the header.

import { Component, Show } from "solid-js";
import {
  chromeShown,
  customChrome,
  fullscreen,
  notePointerOnChrome,
} from "../stores/windowStore";
import WindowControls from "./WindowControls";

const TitleBar: Component = () => (
  <Show when={customChrome()}>
    <div
      class="titlebar"
      classList={{
        "titlebar--autohide": fullscreen(),
        "titlebar--shown": fullscreen() && chromeShown(),
      }}
      data-tauri-drag-region
      onPointerEnter={() => notePointerOnChrome(true)}
      onPointerLeave={() => notePointerOnChrome(false)}
    >
      <WindowControls />
    </div>
  </Show>
);

export default TitleBar;
