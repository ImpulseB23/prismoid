// The update splash window: the update screen on its own while the
// installer replaces the app. It runs from a copy of the exe with its own
// WebView2 data, so it has no settings; the palette comes in the URL.

import type { Component } from "solid-js";
import { UpdateView } from "./components/UpdateScreen";
import logoOnDark from "./assets/logo.svg";
import logoOnLight from "./assets/logo-on-light.svg";

const UpdateSplash: Component = () => {
  const light = new URLSearchParams(location.search).get("palette") === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  return (
    <UpdateView
      view={{
        title: "Updating prismoid",
        detail: "Installing",
        progress: null,
        failed: false,
      }}
      logo={light ? logoOnLight : logoOnDark}
    />
  );
};

export default UpdateSplash;
