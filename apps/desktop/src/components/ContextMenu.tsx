// Renders the open right-click menu at the pointer, kept inside the
// window. Mounted once; the store decides what it shows.

import {
  Component,
  For,
  Show,
  createEffect,
  onCleanup,
  onMount,
} from "solid-js";
import {
  closeContextMenu,
  contextMenu,
  type MenuItem,
} from "../stores/contextMenuStore";

const EDGE_GAP = 6;

const ContextMenu: Component = () => {
  let menuRef: HTMLDivElement | undefined;

  onMount(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef && e.target instanceof Node && menuRef.contains(e.target)) {
        return;
      }
      closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    const close = () => closeContextMenu();
    // Only a scroll that moves what was right-clicked closes the menu; with
    // several chats open, another one is always scrolling on its own.
    const onScroll = (e: Event) => {
      const anchor = contextMenu()?.anchor;
      if (!anchor || (e.target instanceof Node && e.target.contains(anchor))) {
        close();
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    });
  });

  // Flip the menu to stay on screen once its size is known.
  createEffect(() => {
    const open = contextMenu();
    if (!open || !menuRef) return;
    const rect = menuRef.getBoundingClientRect();
    const left = Math.min(open.x, window.innerWidth - rect.width - EDGE_GAP);
    const top = Math.min(open.y, window.innerHeight - rect.height - EDGE_GAP);
    menuRef.style.left = `${Math.max(EDGE_GAP, left)}px`;
    menuRef.style.top = `${Math.max(EDGE_GAP, top)}px`;
    menuRef.querySelector<HTMLButtonElement>("button")?.focus();
  });

  const pick = (entry: MenuItem) => {
    if (entry.kind !== "item") return;
    closeContextMenu();
    entry.onSelect();
  };

  return (
    <Show when={contextMenu()}>
      {(open) => (
        <div
          ref={(el) => (menuRef = el)}
          class="ctx"
          role="menu"
          style={{ left: `${open().x}px`, top: `${open().y}px` }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <For each={open().items}>
            {(entry) =>
              entry.kind === "separator" ? (
                <div class="ctx__sep" role="separator" />
              ) : (
                <button
                  type="button"
                  class="ctx__item"
                  classList={{ "ctx__item--danger": entry.danger === true }}
                  role="menuitem"
                  onClick={() => pick(entry)}
                >
                  {entry.label}
                </button>
              )
            }
          </For>
        </div>
      )}
    </Show>
  );
};

export default ContextMenu;
