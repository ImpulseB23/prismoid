// The window prismoid starts in: the update screen while launchUpdate looks
// for an update, then either the install or the app.

import { createSignal, onMount, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { UpdateView, type ScreenView } from "./components/UpdateScreen";
import {
  CHECKING,
  LAUNCH_CHECK_TIMEOUT_MS,
  launchUpdate,
} from "./lib/launchUpdate";
import { findUpdate, startUpdateSplash } from "./stores/updateStore";
import { logo, palette } from "./stores/themeStore";

const LaunchUpdate: Component = () => {
  document.documentElement.dataset.theme = palette();
  const [view, setView] = createSignal<ScreenView>(CHECKING);
  onMount(() => {
    void launchUpdate({
      check: () => findUpdate(LAUNCH_CHECK_TIMEOUT_MS),
      cover: startUpdateSplash,
      open: () => invoke("launch_update_done"),
      show: setView,
    });
  });
  return <UpdateView view={view()} logo={logo()} />;
};

export default LaunchUpdate;
