// The stream manager's sections as tabs across the curtain, since the chat
// window is usually narrow. Arrow keys, Home and End move between them.

import { Component, For, JSX } from "solid-js";
import type { StreamManagerTab } from "../../stores/streamManagerPanelStore";

interface Tab {
  id: StreamManagerTab;
  label: string;
  icon: () => JSX.Element;
}

const TABS: Tab[] = [
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
];

export const tabId = (id: StreamManagerTab) => `sm-tab-${id}`;
export const panelId = (id: StreamManagerTab) => `sm-panel-${id}`;

const SectionTabs: Component<{
  current: StreamManagerTab;
  onPick: (tab: StreamManagerTab) => void;
}> = (props) => {
  let listRef: HTMLDivElement | undefined;

  const move = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === props.current);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (i - 1 + TABS.length) % TABS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    props.onPick(TABS[next].id);
    listRef?.querySelector<HTMLElement>(`#${tabId(TABS[next].id)}`)?.focus();
  };

  return (
    <div
      class="sm-tabs"
      role="tablist"
      aria-label="Stream manager sections"
      ref={(el) => (listRef = el)}
      onKeyDown={move}
    >
      <For each={TABS}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            id={tabId(tab.id)}
            class="sm-tabs__tab"
            classList={{ "sm-tabs__tab--on": props.current === tab.id }}
            aria-selected={props.current === tab.id}
            aria-controls={panelId(tab.id)}
            tabIndex={props.current === tab.id ? 0 : -1}
            onClick={() => props.onPick(tab.id)}
          >
            <span class="sm-tabs__icon" aria-hidden="true">
              {tab.icon()}
            </span>
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default SectionTabs;
