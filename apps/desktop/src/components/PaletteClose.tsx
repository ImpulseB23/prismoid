// The close button in a palette's header.

import { Component } from "solid-js";

const PaletteClose: Component<{ onClick: () => void }> = (props) => (
  <button
    type="button"
    class="icon-btn palette__close"
    aria-label="Close"
    title="Close (Esc)"
    onClick={() => props.onClick()}
  >
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2 2l8 8M10 2l-8 8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  </button>
);

export default PaletteClose;
