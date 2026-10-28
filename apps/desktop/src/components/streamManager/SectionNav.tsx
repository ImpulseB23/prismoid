// The stream manager's section list, grouped the way the streamer thinks
// about the stream. Only sections that are built show up here.

import { Component, For, JSX } from "solid-js";

export type Section = "live";

interface Item {
  id: Section;
  label: string;
  icon: () => JSX.Element;
}

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "On air",
    items: [
      {
        id: "live",
        label: "Live",
        icon: () => (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
            <path
              d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 12.9a7 7 0 0 1 0-9.8M12.9 3.1a7 7 0 0 1 0 9.8"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        ),
      },
    ],
  },
];

const SectionNav: Component<{
  current: Section;
  onPick: (section: Section) => void;
}> = (props) => (
  <nav class="sm__nav" aria-label="Stream manager sections">
    <For each={GROUPS}>
      {(group) => (
        <div class="sm-nav__group" role="group" aria-label={group.label}>
          <span class="sm-nav__label" aria-hidden="true">
            {group.label}
          </span>
          <For each={group.items}>
            {(item) => (
              <button
                type="button"
                class="sm-nav__item"
                classList={{ "sm-nav__item--on": props.current === item.id }}
                aria-current={props.current === item.id ? "page" : undefined}
                onClick={() => props.onPick(item.id)}
              >
                <span class="sm-nav__icon" aria-hidden="true">
                  {item.icon()}
                </span>
                {item.label}
              </button>
            )}
          </For>
        </div>
      )}
    </For>
  </nav>
);

export default SectionNav;
