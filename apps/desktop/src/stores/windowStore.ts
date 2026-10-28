// Whether Prismoid draws its own title bar buttons (the native frame is off,
// which the host does on Windows), whether the window is maximized, so the
// maximize button can show restore instead, and fullscreen. In fullscreen
// the top chrome stays until the pointer leaves it, then folds away, and
// comes back while the pointer is at the top edge or on it.

import { createSignal } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const [customChrome, setCustomChrome] = createSignal(false);
const [maximized, setMaximized] = createSignal(false);
const [fullscreen, setFullscreen] = createSignal(false);
const [chromeShown, setChromeShown] = createSignal(false);

/** How long the chrome lingers after the pointer leaves it. */
export const CHROME_HIDE_MS = 400;
/** Entering fullscreen with the pointer elsewhere (F11) shows it this long. */
export const CHROME_ENTER_MS = 1500;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let pointerOnChrome = false;
let held = false;

export function showChrome(): void {
  clearTimeout(hideTimer);
  setChromeShown(true);
}

export function hideChromeSoon(delay = CHROME_HIDE_MS): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!pointerOnChrome && !held) setChromeShown(false);
  }, delay);
}

/**
 * The top-edge strip reveals the chrome. If the pointer then leaves without
 * crossing onto it, no leave event ever fires, so this hides on its own
 * unless the pointer arrives.
 */
export function peekChrome(): void {
  showChrome();
  hideChromeSoon(CHROME_ENTER_MS);
}

/** The header and title bar report the pointer at all times, so entering fullscreen knows whether it is on them. */
export function notePointerOnChrome(on: boolean): void {
  pointerOnChrome = on;
  if (!fullscreen()) return;
  if (on) showChrome();
  else hideChromeSoon();
}

/**
 * Keeps the chrome down while something opened from it is still open, then
 * lets it fold away once that closes.
 */
export function holdChrome(on: boolean): void {
  if (on === held) return;
  held = on;
  if (!fullscreen()) return;
  if (on) showChrome();
  else hideChromeSoon();
}

/** Records what the window reports, not what was last asked for. */
export function noteFullscreen(on: boolean): void {
  if (on === fullscreen()) return;
  setFullscreen(on);
  showChrome();
  if (on && !pointerOnChrome) hideChromeSoon(CHROME_ENTER_MS);
}

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

export { customChrome, maximized, fullscreen, chromeShown };
