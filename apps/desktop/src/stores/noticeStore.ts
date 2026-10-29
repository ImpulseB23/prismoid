// One transient line of feedback in a pane for actions taken outside a
// dialog (the right-click menu): what happened, or why it failed. Replaced
// by the next notice and cleared on its own.

import { createSignal, onCleanup } from "solid-js";

export const NOTICE_MS = 4000;

export interface NoticeLine {
  notice: () => string | null;
  notify: (text: string) => void;
}

/** Call inside a component; its timer stops with the owner. */
export function createNoticeLine(): NoticeLine {
  const [notice, setNotice] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return {
    notice,
    notify: (text) => {
      setNotice(text);
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), NOTICE_MS);
    },
  };
}
