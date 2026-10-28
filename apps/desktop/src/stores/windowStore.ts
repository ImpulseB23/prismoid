// Whether Prismoid draws its own title bar buttons (the native frame is off,
// which the host does on Windows) and whether the window is maximized, so the
// maximize button can show restore instead.

import { createSignal } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const [customChrome, setCustomChrome] = createSignal(false);
const [maximized, setMaximized] = createSignal(false);

/** Reads the window's frame state once and follows maximize changes. Returns a stop function. */
export async function trackWindowChrome(): Promise<() => void> {
  const win = getCurrentWindow();
  const [decorated, max] = await Promise.all([
    win.isDecorated(),
    win.isMaximized(),
  ]);
  setCustomChrome(!decorated);
  setMaximized(max);
  if (decorated) return () => {};
  return win.onResized(() => {
    void win
      .isMaximized()
      .then(setMaximized)
      .catch((err: unknown) => console.error("is maximized", err));
  });
}

export { customChrome, maximized };
