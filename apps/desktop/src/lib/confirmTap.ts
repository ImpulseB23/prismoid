// Two-tap confirmation for actions that cannot be undone (clearing chat,
// clearing mentions): the first tap arms, a second within the window runs
// it, and the button settles back on its own if nothing follows.

import { createSignal, onCleanup } from "solid-js";

/** How long an armed button waits for the second tap. */
export const CLEAR_CONFIRM_MS = 4000;

export function createConfirmTap(ms = CLEAR_CONFIRM_MS) {
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const disarm = () => {
    clearTimeout(timer);
    setArmed(false);
  };

  /** True when this tap confirms; false when it only armed the button. */
  const tap = (): boolean => {
    clearTimeout(timer);
    if (armed()) {
      setArmed(false);
      return true;
    }
    setArmed(true);
    timer = setTimeout(() => setArmed(false), ms);
    return false;
  };

  return { armed, tap, disarm };
}
