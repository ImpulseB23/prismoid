// The one open right-click menu. Any surface can open it with a list of
// items at the pointer; the ContextMenu component renders it and closes it
// on outside click, Escape, scroll or focus loss.

import { createSignal } from "solid-js";

export type MenuItem =
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      danger?: boolean;
    }
  | { kind: "separator" };

export interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
  /** What was right-clicked; the menu closes when something holding it
   * scrolls, not when an unrelated chat scrolls on its own. */
  anchor: Element | null;
}

const [contextMenu, setContextMenu] = createSignal<OpenMenu | null>(null);

export { contextMenu };

export function openContextMenu(
  e: {
    clientX: number;
    clientY: number;
    target: EventTarget | null;
    preventDefault(): void;
  },
  items: MenuItem[],
): void {
  e.preventDefault();
  if (items.length === 0) return;
  setContextMenu({
    x: e.clientX,
    y: e.clientY,
    items,
    anchor: e.target instanceof Element ? e.target : null,
  });
}

export function closeContextMenu(): void {
  setContextMenu(null);
}

export function item(
  label: string,
  onSelect: () => void,
  danger = false,
): MenuItem {
  return { kind: "item", label, onSelect, danger };
}

export const separator: MenuItem = { kind: "separator" };
