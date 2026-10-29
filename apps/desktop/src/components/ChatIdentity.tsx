// How you look in chat: a preview of your name and badges in the open
// channel, Twitch's name colors to pick from (a custom one with Turbo or
// Prime), and where to change badges, which only Twitch can. Changing the
// color needs one more Twitch permission, asked for the first time here.

import { Component, For, Show, createSignal } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSession } from "../lib/chatSession";
import { nameStyle } from "../lib/paint";
import {
  formatChannelError,
  updateChatColor,
  type NamedChatColor,
} from "../lib/twitchChannel";
import { currentUserId, scopeGroupReady } from "../stores/authStore";
import {
  loadOwnColor,
  ownBadges,
  ownColor,
  ownDisplayName,
} from "../stores/ownIdentityStore";
import { shownPaint } from "../stores/paintStore";
import { nameContrast } from "../stores/themeStore";
import ScopeGroupCard from "./streamManager/ScopeGroupCard";

/** Twitch's named colors and the hex it stores for each. */
const NAMED_COLORS: [NamedChatColor, string, string][] = [
  ["red", "#FF0000", "Red"],
  ["orange_red", "#FF4500", "Orange red"],
  ["coral", "#FF7F50", "Coral"],
  ["chocolate", "#D2691E", "Chocolate"],
  ["golden_rod", "#DAA520", "Goldenrod"],
  ["yellow_green", "#9ACD32", "Yellow green"],
  ["spring_green", "#00FF7F", "Spring green"],
  ["green", "#008000", "Green"],
  ["sea_green", "#2E8B57", "Sea green"],
  ["cadet_blue", "#5F9EA0", "Cadet blue"],
  ["dodger_blue", "#1E90FF", "Dodger blue"],
  ["blue", "#0000FF", "Blue"],
  ["blue_violet", "#8A2BE2", "Blue violet"],
  ["hot_pink", "#FF69B4", "Hot pink"],
  ["firebrick", "#B22222", "Firebrick"],
];

const ChatIdentity: Component<{ login: string }> = (props) => {
  const session = useSession();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [custom, setCustom] = createSignal(ownColor() ?? "#9146FF");

  const channel = () => session().channel;
  const badges = () => {
    const c = channel();
    const store = session().badges;
    store.revision();
    if (!c) return [];
    return (ownBadges(c.id) ?? []).flatMap((b) => {
      const r = store.resolve(b.set_id, b.id);
      return r ? [r] : [];
    });
  };
  const name = () => {
    const me = currentUserId();
    return nameStyle(
      ownColor(),
      me ? shownPaint(me) : undefined,
      nameContrast(),
    );
  };
  const displayName = () => {
    const c = channel();
    return (c && ownDisplayName(c.id)) || props.login;
  };
  const current = () => ownColor()?.toUpperCase();

  const pick = async (color: string) => {
    setBusy(true);
    setError(null);
    try {
      await updateChatColor(color);
      await loadOwnColor();
    } catch (e) {
      setError(formatChannelError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="identity">
      <div class="identity__preview" aria-label="How you look in chat">
        <For each={badges()}>
          {(b) => (
            <img
              src={b.url_2x || b.url_1x}
              alt={b.title}
              title={b.title}
              width={18}
              height={18}
              draggable={false}
            />
          )}
        </For>
        <span
          class="identity__name"
          classList={{ "name--painted": name().painted }}
          style={name().style}
        >
          {displayName()}
        </span>
        <span class="identity__sample">: hello chat</span>
      </div>

      <Show
        when={scopeGroupReady("chat_color")}
        fallback={<ScopeGroupCard group="chat_color" />}
      >
        <span class="identity__label">Name color</span>
        <div
          class="identity__swatches"
          role="radiogroup"
          aria-label="Name color"
        >
          <For each={NAMED_COLORS}>
            {([value, hex, label]) => (
              <button
                type="button"
                role="radio"
                class="identity__swatch"
                aria-checked={current() === hex}
                aria-label={label}
                title={label}
                disabled={busy()}
                style={{ background: hex }}
                onClick={() => void pick(value)}
              />
            )}
          </For>
        </div>
        <div class="identity__custom">
          <input
            type="color"
            aria-label="Custom color"
            value={custom()}
            onInput={(e) => setCustom(e.currentTarget.value)}
          />
          <button
            type="button"
            class="btn btn--small btn--outline"
            disabled={busy()}
            onClick={() => void pick(custom().toUpperCase())}
          >
            Use custom color
          </button>
          <span class="settings__hint">Needs Turbo or Prime</span>
        </div>
        <Show when={error()}>
          {(e) => (
            <div class="dialog__error" role="alert">
              {e()}
            </div>
          )}
        </Show>
      </Show>

      <Show when={channel()}>
        {(c) => (
          <p class="settings__hint identity__badges">
            Badges are picked on Twitch, in the chat settings under Chat
            Identity.{" "}
            <button
              type="button"
              class="settings__link"
              onClick={() =>
                void openUrl(
                  `https://www.twitch.tv/popout/${c().login}/chat`,
                ).catch((err: unknown) => console.error("open chat", err))
              }
            >
              Open {c().display_name}'s chat on Twitch
            </button>
          </p>
        )}
      </Show>
    </div>
  );
};

export default ChatIdentity;
