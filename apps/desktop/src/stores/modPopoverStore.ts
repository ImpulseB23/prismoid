// The one open moderation popup: a timeout length picker or a warning
// reason, anchored where it was asked for. The ModPopover component renders
// it; whoever opens it says what happens on submit.

import { createSignal } from "solid-js";

export type ModPopover = {
  x: number;
  y: number;
  /** Display name of the person the action targets. */
  target: string;
} & (
  | { kind: "timeout"; presets: number[]; submit: (seconds: number) => void }
  | { kind: "warn"; submit: (reason: string) => void }
);

const [modPopover, setModPopover] = createSignal<ModPopover | null>(null);

export { modPopover };

export function openModPopover(popover: ModPopover): void {
  setModPopover(popover);
}

export function closeModPopover(): void {
  setModPopover(null);
}
