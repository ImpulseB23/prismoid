// A small preview of the channel's stream in the top right corner of a
// pane's chat, through Twitch's embedded player: Twitch's own page in a
// frame, so none of Twitch's code runs in the app. The frame is sandboxed
// so the player cannot navigate the window away or open new ones. Twitch
// requires at least 400x300, which sets the preview's size; a chat too
// small for that says which way it falls short.

import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
/** 16:9 at Twitch's minimum height. */
const PREVIEW_WIDTH = 534;
/** Gap between the preview and the chat's edges. */
const INSET = 12;

export function playerUrl(login: string, parent: string): string {
  const url = new URL("https://player.twitch.tv/");
  url.searchParams.set("channel", login);
  url.searchParams.set("parent", parent);
  url.searchParams.set("autoplay", "true");
  return url.toString();
}

export type VideoFit = { width: number; height: number } | "narrow" | "short";

/**
 * The smallest player Twitch allows, 16:9 where the chat is wide enough
 * and down to 400 wide where it is not.
 */
export function videoSize(chatWidth: number, chatHeight: number): VideoFit {
  const width = Math.min(PREVIEW_WIDTH, chatWidth - INSET * 2);
  if (width < MIN_WIDTH) return "narrow";
  if (chatHeight - INSET * 2 < MIN_HEIGHT) return "short";
  return { width, height: MIN_HEIGHT };
}

const StreamVideo: Component<{ login: string; name: string }> = (props) => {
  let ref: HTMLDivElement | undefined;
  const [pane, setPane] = createSignal({ width: 0, height: 0 });
  onMount(() => {
    const host = ref?.parentElement;
    if (!host) return;
    const measure = () =>
      setPane({ width: host.clientWidth, height: host.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    measure();
    onCleanup(() => ro.disconnect());
  });
  const fit = () => videoSize(pane().width, pane().height);
  const size = () => {
    const f = fit();
    return typeof f === "string" ? null : f;
  };

  return (
    <div class="stream-video" ref={(el) => (ref = el)}>
      <Show
        when={size()}
        fallback={
          <p class="stream-video__small">
            {fit() === "narrow"
              ? "Widen this pane to show the stream"
              : "Make the window taller to show the stream"}
          </p>
        }
      >
        {(s) => (
          <iframe
            class="stream-video__player"
            src={playerUrl(props.login, location.hostname)}
            title={`${props.name}'s stream`}
            width={s().width}
            height={s().height}
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />
        )}
      </Show>
    </div>
  );
};

export default StreamVideo;
