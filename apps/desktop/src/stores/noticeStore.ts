// One transient line of feedback for actions taken outside a dialog (the
// right-click menu): what happened, or why it failed. Replaced by the next
// notice and cleared on its own.

import { createSignal } from "solid-js";

export const NOTICE_MS = 4000;

const [notice, setNotice] = createSignal<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

export { notice };

export function notify(text: string): void {
  setNotice(text);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => setNotice(null), NOTICE_MS);
}
