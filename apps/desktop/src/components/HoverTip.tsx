// A small card floating over chat while the pointer rests on something: above
// its anchor, or below it near the top edge, kept inside the window. It is
// placed again whenever its size changes, e.g. when a picture loads. The
// user scrolling, the window losing focus or resizing dismisses it; chat
// moving on its own does not.

import {
  createEffect,
  onCleanup,
  onMount,
  type ParentComponent,
} from "solid-js";

const EDGE_GAP = 8;
const ANCHOR_GAP = 8;

const HoverTip: ParentComponent<{
  anchor: DOMRect;
  class: string;
  onDismiss: () => void;
}> = (props) => {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    const dismiss = () => props.onDismiss();
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    onCleanup(() => {
      window.removeEventListener("wheel", dismiss, { capture: true });
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    });
  });

  const place = () => {
    if (!ref) return;
    const box = ref.getBoundingClientRect();
    const a = props.anchor;
    const above = a.top - box.height - ANCHOR_GAP;
    const top = above >= EDGE_GAP ? above : a.bottom + ANCHOR_GAP;
    const centered = a.left + a.width / 2 - box.width / 2;
    const left = Math.min(
      Math.max(EDGE_GAP, centered),
      window.innerWidth - box.width - EDGE_GAP,
    );
    ref.style.top = `${top}px`;
    ref.style.left = `${left}px`;
    ref.style.visibility = "visible";
  };

  // Placed once its size is known, before the frame paints.
  createEffect(place);
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !ref) return;
    const ro = new ResizeObserver(place);
    ro.observe(ref);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div ref={(el) => (ref = el)} class={props.class} role="tooltip">
      {props.children}
    </div>
  );
};

export default HoverTip;
