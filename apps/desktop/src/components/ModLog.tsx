// Every moderator action seen in the open channel this session, newest
// first: timeouts, bans, deletions and mode changes, by any mod.

import { Component, For, Show, createSignal } from "solid-js";
import { useSession } from "../lib/chatSession";
import { modActionsIn, modLogRevision } from "../stores/modLogStore";
import { describeModAction } from "../lib/modActions";
import { formatTimestamp } from "../lib/messageStyle";
import type { ModAction } from "../lib/chatEvents";

export type ModLogFilter = "all" | "punish" | "delete" | "modes";

const PUNISH = new Set([
  "timeout",
  "untimeout",
  "ban",
  "unban",
  "warn",
  "shared_chat_timeout",
  "shared_chat_untimeout",
  "shared_chat_ban",
  "shared_chat_unban",
]);
const DELETE = new Set(["delete", "shared_chat_delete", "clear"]);

export function matchesFilter(a: ModAction, f: ModLogFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "punish":
      return PUNISH.has(a.action);
    case "delete":
      return DELETE.has(a.action);
    case "modes":
      return !PUNISH.has(a.action) && !DELETE.has(a.action);
  }
}

const FILTERS: [ModLogFilter, string][] = [
  ["all", "All"],
  ["punish", "Timeouts and bans"],
  ["delete", "Deletions"],
  ["modes", "Modes and roles"],
];

const ModLog: Component = () => {
  const session = useSession();
  const [filter, setFilter] = createSignal<ModLogFilter>("all");

  const rows = () => {
    modLogRevision();
    const id = session().channel?.id;
    if (id === undefined) return [];
    return modActionsIn(id).filter((a) => matchesFilter(a, filter()));
  };

  return (
    <div class="cc__body">
      <div class="modlog__filters" role="tablist">
        <For each={FILTERS}>
          {([key, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter() === key}
              class="modbar__chip"
              classList={{ "modbar__chip--on": filter() === key }}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="cc__empty">
            Nothing yet this session. Timeouts, bans, deletions and mode changes
            by any mod in this channel show up here.
          </div>
        }
      >
        <ol class="modlog__list">
          <For each={rows()}>
            {(a) => (
              <li class="modlog__row">
                <span class="msg__time">{formatTimestamp(a.timestamp)}</span>
                <span>{describeModAction(a)}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
};

export default ModLog;
