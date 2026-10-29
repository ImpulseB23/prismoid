import {
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { getRequestEvent } from "solid-js/web";
import { createAsync, query } from "@solidjs/router";
import { Title, Meta } from "@solidjs/meta";
import GithubPreview from "~/components/GithubPreview";
import {
  ChatManagerShot,
  ChatShot,
  ManagerShot,
  ModFeedShot,
} from "~/components/ProductMocks";
import {
  detectPlatform,
  INSTALLERS,
  PLATFORM_NAMES,
  type Platform,
} from "~/lib/platform";
import "./index.css";

const GitHubIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const WindowsIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor">
    <path d="M0 2.3 6.5 1.4v6.3H0V2.3Zm7.3-1 8.7-1.3v7.7H7.3V1.3ZM0 8.3h6.5v6.3L0 13.7V8.3Zm7.3 0H16V16l-8.7-1.2V8.3Z" />
  </svg>
);

// Detected on the server from the request headers, so the first paint
// already shows the right button and nothing flickers after hydration.
const visitorPlatform = query(async (): Promise<Platform> => {
  "use server";
  const event = getRequestEvent();
  return event ? detectPlatform(event.request.headers) : "unknown";
}, "visitorPlatform");

// Visitors we cannot place get the Windows button, since that is the only
// installer there is. Everyone else sees their own platform, with a plain
// "not yet" where no build exists instead of a Windows exe they cannot run.
// rel="external" keeps the router from treating /download as a page, so the
// click is a real request and the installer starts downloading.
function Download(props: { platform: Platform | undefined }) {
  const target = () =>
    props.platform === undefined || props.platform === "unknown"
      ? "windows"
      : props.platform;
  return (
    <Show
      when={INSTALLERS[target()]}
      fallback={
        <span class="no-build">No {PLATFORM_NAMES[target()]} build yet</span>
      }
    >
      <a
        href={`/download/${target()}`}
        rel="external"
        class="btn btn-primary btn-gold btn-hero"
      >
        <WindowsIcon /> Download for {PLATFORM_NAMES[target()]}
      </a>
    </Show>
  );
}

function DownloadNote(props: { platform: Platform | undefined }) {
  const target = () => props.platform ?? "unknown";
  const phone = () => target() === "ios" || target() === "android";
  const otherDesktop = () =>
    target() === "macos" || target() === "linux" || target() === "chromeos";
  return (
    <p class="download-note">
      <Switch
        fallback={
          <>
            Windows 10 and 11. Early build, not code signed yet, so Windows
            shows a warning once.{" "}
            <a href="/install" class="inline-link">
              Here is what to click
            </a>
            . macOS and Linux later.
          </>
        }
      >
        <Match when={phone()}>
          There is no {PLATFORM_NAMES[target()]} app. prismoid is a desktop app
          for your PC, so open prismoid.org on Windows to download it.
        </Match>
        <Match when={otherDesktop()}>
          Windows only for now, macOS and Linux later. Got a Windows PC too?{" "}
          <a href="/download/windows" rel="external" class="inline-link">
            Download for Windows
          </a>
          .
        </Match>
      </Switch>
    </p>
  );
}

// The app, drawn in markup so it stays sharp at any size and never goes
// stale next to a screenshot of an older build. Messages keep arriving so
// the still reads as what it is: a live chat window.
type Line =
  | {
      kind: "msg";
      badge?: "sub" | "vip" | "mod";
      name: string;
      color: string;
      text: () => JSX.Element;
      deleted?: boolean;
    }
  | { kind: "notice"; text: () => JSX.Element };

const FEED: Line[] = [
  {
    kind: "msg",
    badge: "sub",
    name: "sleepyfern",
    color: "#4fa3ff",
    text: () => (
      <>
        she is NOT reading chat <span class="mock__emote" />
      </>
    ),
  },
  {
    kind: "msg",
    badge: "vip",
    name: "remindbot",
    color: "#ff69b4",
    text: () => <>@noodle_hours, reminder from yourself (1m ago): feed cat</>,
  },
  {
    kind: "msg",
    badge: "mod",
    name: "crumbs_42",
    color: "#3ddc84",
    text: () => (
      <>
        <span class="mock__emote mock__emote--b" /> she found the setting
      </>
    ),
  },
  {
    kind: "notice",
    text: () => (
      <>
        <b>crumbs_42</b> timed out <b>spammer_4421</b> for 10m: links
      </>
    ),
  },
  {
    kind: "msg",
    badge: "sub",
    name: "kettlewhistle",
    color: "#ffb020",
    text: () => (
      <>
        how is chat this fast <span class="mock__emote mock__emote--c" />
      </>
    ),
  },
  {
    kind: "msg",
    name: "spammer_4421",
    color: "#8f8f8f",
    deleted: true,
    text: () => <>FREE FOLLOWERS at bit dot ly slash</>,
  },
  {
    kind: "msg",
    badge: "mod",
    name: "you",
    color: "#a78bfa",
    text: () => (
      <>
        <span class="mock__mention">@kettlewhistle</span> it skips the website
      </>
    ),
  },
  {
    kind: "msg",
    name: "noodle_hours",
    color: "#ff4d8d",
    text: () => <>wait it remembers the chat from before I opened it??</>,
  },
  {
    kind: "msg",
    badge: "vip",
    name: "tabby_owl",
    color: "#4fa3ff",
    text: () => (
      <>
        tabs AND history <span class="mock__emote" /> finally
      </>
    ),
  },
  {
    kind: "notice",
    text: () => (
      <>
        <b>you</b> deleted a message from <b>spammer_4421</b>
      </>
    ),
  },
];

const SHOWN = 7;

function AppMock() {
  const [head, setHead] = createSignal(SHOWN - 1);
  onMount(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setHead((h) => h + 1), 1700);
    onCleanup(() => clearInterval(id));
  });
  const visible = () =>
    Array.from({ length: SHOWN }, (_, i) => {
      const at = head() - SHOWN + 1 + i;
      return FEED[((at % FEED.length) + FEED.length) % FEED.length];
    });

  return (
    <div class="mock" aria-hidden="true">
      <div class="mock__bar">
        <span class="mock__logo" />
        <span class="mock__channel">pixelgoose</span>
        <span class="mock__dot" />
      </div>
      <div class="mock__tabs">
        <span class="mock__tab mock__tab--active">pixelgoose</span>
        <span class="mock__tab">
          moss_rally <b>12</b>
        </span>
        <span class="mock__tab">your_mod_channel</span>
        <span class="mock__tab mock__tab--add">+</span>
      </div>
      <div class="mock__stream">
        <b>Live</b> 2,318 viewers 3:12:08 <i>Just Chatting</i>
      </div>
      <div class="mock__feed">
        <For each={visible()}>
          {(line, i) => (
            <Switch>
              <Match when={line.kind === "notice" && line}>
                {(n) => (
                  <div
                    class="mock__notice"
                    classList={{ "mock__line--new": i() === SHOWN - 1 }}
                  >
                    {n().text()}
                  </div>
                )}
              </Match>
              <Match when={line.kind === "msg" && line}>
                {(m) => (
                  <div
                    class="mock__msg"
                    classList={{
                      "mock__msg--deleted": m().deleted,
                      "mock__line--new": i() === SHOWN - 1,
                    }}
                  >
                    <Show when={m().badge}>
                      {(b) => (
                        <span class={`mock__badge mock__badge--${b()}`} />
                      )}
                    </Show>
                    <span class="mock__name" style={{ color: m().color }}>
                      {m().name}
                    </span>
                    <span>{m().text()}</span>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
      <div class="mock__composer">
        <span>Message pixelgoose</span>
        <span class="mock__send" />
      </div>
    </div>
  );
}

export default function Home() {
  const platform = createAsync(() => visitorPlatform(), { deferStream: true });
  return (
    <>
      <Title>
        prismoid - Twitch chat and a stream manager for your desktop
      </Title>
      <Meta
        name="description"
        content="prismoid is a free, open source desktop app for Twitch chat. Channels sit in tabs and keep their history, mod actions show up in chat, and if you stream, your title, ads and polls are in a panel above it."
      />
      <Meta
        property="og:title"
        content="prismoid - Twitch chat and a stream manager for your desktop"
      />
      <Meta
        property="og:description"
        content="A free, open source desktop app for Twitch chat, with a stream manager for your title, ads and polls."
      />
      <Meta property="og:image" content="/icons/icon-512.png" />
      <Meta property="og:url" content="https://prismoid.org" />
      <Meta name="twitter:card" content="summary" />

      <section class="hero">
        <div class="hero__beam" aria-hidden="true" />
        <div class="hero__copy">
          <h1>A desktop app for Twitch chat and your stream</h1>
          <p class="lede">
            Read and moderate chat in tabs. When you go live, your title, ads
            and polls sit right above it.
          </p>
          <div class="hero-actions">
            <Download platform={platform()} />
            <GithubPreview
              href="https://github.com/ImpulseB23/Prismoid"
              class="btn btn-outline btn-hero"
              target="_blank"
            >
              <GitHubIcon /> View source
            </GithubPreview>
          </div>
          <p class="hero__plain">Free and open source.</p>
          <DownloadNote platform={platform()} />
        </div>
        <AppMock />
      </section>

      <section class="feature feature--chat">
        <div class="feature__text">
          <h2>Chat</h2>
          <p>
            Every channel gets its own tab. The ones you are not looking at
            count what you missed.
          </p>
          <p>
            Chat is still there after a restart, so you can scroll back to last
            night.
          </p>
          <p>
            7TV, BTTV and FFZ emotes show up next to Twitch's own. Right-click
            one to see its name, which set it is from and who made it.
          </p>
        </div>
        <ChatShot />
      </section>

      <section class="feature feature--mod">
        <div class="feature__text">
          <h2>Moderation</h2>
          <p>
            Timeouts and bans show up in chat right where they happened. In
            channels you mod, you also see who did it and the reason they gave.
          </p>
          <ModFeedShot />
        </div>
        <div class="feature__side">
          <ChatManagerShot />
          <p>Room modes, the AutoMod queue and the mod log share one panel.</p>
        </div>
      </section>

      <section class="feature feature--manager">
        <div class="feature__text">
          <h2>Stream manager</h2>
          <p>
            One button pulls it down over chat like a curtain, and chat keeps
            going underneath. Your uptime, viewers and next ad are along the
            top, with the stream so far laid out on a timeline.
          </p>
          <p>Change your title, category and tags without opening Twitch.</p>
        </div>
        <ManagerShot />
        <p class="feature__note">
          Ads, polls and predictions are for Affiliates and Partners.
        </p>
      </section>

      <section class="later">
        <h2>What is not there yet</h2>
        <ul>
          <li>It only runs on Windows for now. Mac and Linux come later.</li>
          <li>
            YouTube and Kick chat are not hooked up yet. Twitch comes first.
          </li>
          <li>There is no OBS dock yet, so chat cannot sit inside OBS.</li>
        </ul>
      </section>

      <section class="cta">
        <h2>Try it on your next stream</h2>
        <Download platform={platform()} />
      </section>
    </>
  );
}
