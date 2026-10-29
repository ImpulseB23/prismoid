// The channel's stream above a pane's chat, through Twitch's embedded
// player: Twitch's own page in a frame, so none of Twitch's code runs in
// the app. The frame is sandboxed so the player cannot navigate the window
// away or open new ones. Twitch requires at least 400x300 and an unobscured
// player, so a pane too small for that says so instead.

import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
/** The video never takes more of its pane than this, so chat stays usable. */
const MAX_SHARE = 0.5;

export function playerUrl(login: string, parent: string): string {
  const url = new URL("https://player.twitch.tv/");
  url.searchParams.set("channel", login);
  url.searchParams.set("parent", parent);
  url.searchParams.set("autoplay", "true");
  return url.toString();
}

/** 16:9 at the pane's width, capped at a share of its height. */
export function videoSize(
  paneWidth: number,
  paneHeight: number,
): { width: number; height: number } | null {
  const height = Math.min((paneWidth * 9) / 16, paneHeight * MAX_SHARE);
  if (paneWidth < MIN_WIDTH || height < MIN_HEIGHT) return null;
  return { width: paneWidth, height: Math.floor(height) };
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
  const size = () => videoSize(pane().width, pane().height);

  return (
    <div class="stream-video" ref={(el) => (ref = el)}>
      <Show
        when={size()}
        fallback={
          <p class="stream-video__small">
            Make this pane at least {MIN_WIDTH}px wide to show the stream.
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
