// The update splash window: the update screen on its own while the
// installer replaces the app. It runs from a copy of the exe with its own
// WebView2 data, so it has no settings; the palette comes in the URL. When
// the install fails the host sets the hash to #failed while it reopens the
// installed version.

import { createSignal, onCleanup, type Component } from "solid-js";
import { UpdateView } from "./components/UpdateScreen";
import logoOnDark from "./assets/logo.svg";
import logoOnLight from "./assets/logo-on-light.svg";

const UpdateSplash: Component = () => {
  const light = new URLSearchParams(location.search).get("palette") === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  const [failed, setFailed] = createSignal(location.hash === "#failed");
  const onHash = () => setFailed(location.hash === "#failed");
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  return (
    <UpdateView
      view={
        failed()
          ? {
              title: "Update did not finish",
              detail: "Opening prismoid again",
              progress: null,
              failed: false,
            }
          : {
              title: "Updating prismoid",
              detail: "Installing",
              progress: null,
              failed: false,
            }
      }
      logo={light ? logoOnLight : logoOnDark}
    />
  );
};

export default UpdateSplash;
