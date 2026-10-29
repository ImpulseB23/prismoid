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
import Icon from "~/components/Icons";
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
    name: "Tricklord",
    color: "#4fa3ff",
    text: () => (
      <>
        he is NOT reading chat <span class="mock__emote" />
      </>
    ),
  },
  {
    kind: "msg",
    badge: "vip",
    name: "supibot",
    color: "#ff69b4",
    text: () => <>@brayanx2, reminder from yourself (1m, 5s ago): $fish</>,
  },
  {
    kind: "msg",
    badge: "mod",
    name: "nymn",
    color: "#3ddc84",
    text: () => (
      <>
        pepeLaugh <span class="mock__emote mock__emote--b" /> he found the
        setting
      </>
    ),
  },
  {
    kind: "notice",
    text: () => (
      <>
        <b>nymn</b> timed out <b>spammer_4421</b> for 10m: links
      </>
    ),
  },
  {
    kind: "msg",
    badge: "sub",
    name: "kebabloverr",
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
        <span class="mock__mention">@kebabloverr</span> it skips the website
      </>
    ),
  },
  {
    kind: "msg",
    name: "ramen_dev",
    color: "#ff4d8d",
    text: () => <>wait it remembers the chat from before I opened it??</>,
  },
  {
    kind: "msg",
    badge: "vip",
    name: "xqcL",
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
        <span class="mock__channel">xqc</span>
        <span class="mock__dot" />
      </div>
      <div class="mock__tabs">
        <span class="mock__tab mock__tab--active">xqc</span>
        <span class="mock__tab">
          forsen <b>12</b>
        </span>
        <span class="mock__tab">your_mod_channel</span>
        <span class="mock__tab mock__tab--add">+</span>
      </div>
      <div class="mock__stream">
        <b>Live</b> 41.2k viewers 3:12:08 <i>Just Chatting</i>
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
        <span>Message xqc</span>
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
        content="A desktop app for Twitch chat with a stream manager built in. Chat in tabs, history that survives a restart, mod actions you can see and your 7TV, BTTV and FFZ emotes. Your title, ads and polls are a button away. Free and open source."
      />
      <Meta
        property="og:title"
        content="prismoid - Twitch chat and a stream manager for your desktop"
      />
      <Meta
        property="og:description"
        content="Twitch chat in tabs with history, visible mod actions and your emotes, plus a stream manager that drops down over chat. Free and open source."
      />
      <Meta property="og:image" content="/icons/icon-512.png" />
      <Meta property="og:url" content="https://prismoid.org" />
      <Meta name="twitter:card" content="summary" />

      <section class="hero">
        <div class="hero__beam" aria-hidden="true" />
        <div class="hero__copy">
          <h1>
            Your Twitch chat,
            <br />
            with the stream controls right above it.
          </h1>
          <p class="lede">
            prismoid is a desktop app for Twitch chat. Every channel gets a tab,
            history survives a restart, you see timeouts and bans as they
            happen, and your 7TV, BTTV and FFZ emotes show up like they should.
            If you stream, the stream manager drops down over chat so you can
            change your title, run a poll or clip something without leaving it.
            It is free and open source.
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
          <DownloadNote platform={platform()} />
          <ul class="works-with" aria-label="Works with">
            <li>Works with</li>
            <li>Twitch</li>
            <li>7TV</li>
            <li>BetterTTV</li>
            <li>FrankerFaceZ</li>
          </ul>
        </div>
        <AppMock />
      </section>

      <section class="why">
        <h2>Leave it open all stream</h2>
        <div class="why__grid">
          <div class="why__item">
            <Icon name="feather" class="why__icon" />
            <h3>Light on your PC</h3>
            <p>
              It installs quickly and sits next to your stream without taking
              anything from it. There is no browser bundled into the download,
              and nothing runs in the background that you did not start.
            </p>
          </div>
          <div class="why__item">
            <Icon name="bolt" class="why__icon" />
            <h3>Keeps up with big chats</h3>
            <p>
              It opens right away, and scrolling stays smooth even when the
              biggest channel on Twitch is spamming all at once.
            </p>
          </div>
          <div class="why__item">
            <Icon name="shield" class="why__icon" />
            <h3>Gets back up by itself</h3>
            <p>
              If the connection to Twitch drops, prismoid reconnects in the
              background while you keep reading. The app stays open the whole
              time.
            </p>
          </div>
          <div class="why__item">
            <Icon name="direct" class="why__icon" />
            <h3>Just you and Twitch</h3>
            <p>
              Your PC talks straight to Twitch. There is no prismoid account to
              make or pay for, and your sign-in stays on your machine.
            </p>
          </div>
        </div>
      </section>

      <section class="moments">
        <div class="moment">
          <Icon name="history" class="moment__icon" />
          <h2>You tab back and chat has moved on without you.</h2>
          <p>
            Scroll up as far as you like. prismoid saves each channel's chat on
            your PC and loads it again when you come back, even after a restart.
            The first time you open a channel it grabs the recent messages too,
            so you never start out staring at an empty chat.
          </p>
        </div>
        <div class="moment">
          <Icon name="gavel" class="moment__icon" />
          <h2>Someone got timed out and nobody knows why.</h2>
          <p>
            Timeouts, bans and deletions show up in chat as they happen, in
            every channel. Where you moderate, you also get who did it and the
            reason, and you can time someone out, ban them or delete the message
            right from chat.
          </p>
        </div>
        <div class="moment">
          <Icon name="tabs" class="moment__icon" />
          <h2>Your browser is full of chat popouts.</h2>
          <p>
            Give every channel a tab instead. Ctrl+Tab moves between them, the
            ones you are not looking at show an unread count, and they all share
            one connection, so Twitch never cuts you off for having too many
            open.
          </p>
        </div>
        <div class="moment">
          <Icon name="smile" class="moment__icon" />
          <h2>The emotes your chat actually uses</h2>
          <p>
            7TV, BTTV and FFZ emotes show up next to Twitch's own, and badges
            and replies look the way you expect. Right-click an emote to see
            what it is and where it came from.
          </p>
        </div>
        <div class="moment">
          <Icon name="browser" class="moment__icon" />
          <h2>Watching in the browser anyway?</h2>
          <p>
            Turn on follow mode and prismoid switches to whatever Twitch channel
            is open in your front browser window. Keep it on top of the stream
            and you can stop using the site's chat.
          </p>
        </div>
      </section>

      <section class="manager">
        <h2>If you stream, it all sits behind one button</h2>
        <p class="manager__lede">
          Click the stream manager button in the header and it drops down over
          chat. Chat keeps running underneath, and the panel rolls back up when
          you are done. In there you can:
        </p>
        <ul class="manager__list">
          <li>
            <Icon name="sliders" class="manager__icon" />
            <p>
              Change your title, category, tags, language, content labels and
              branded content.
            </p>
          </li>
          <li>
            <Icon name="history" class="manager__icon" />
            <p>
              Check uptime and viewers, with a timeline of where each ad break,
              marker and poll landed.
            </p>
          </li>
          <li>
            <Icon name="bolt" class="manager__icon" />
            <p>
              Drop a marker, clip what just happened, shout out a friend, post
              an announcement or turn on Shield Mode.
            </p>
          </li>
          <li>
            <Icon name="poll" class="manager__icon" />
            <p>
              See when the next ad is due and snooze it or run one now. If you
              are an Affiliate or Partner you can also start polls and
              predictions and watch the votes come in.
            </p>
          </li>
        </ul>
        <p class="manager__note">
          Mods get a chat manager panel with room modes, the AutoMod queue and
          the mod log. prismoid only asks Twitch for stream permissions when you
          turn a part of the stream manager on, and not before.
        </p>
      </section>

      <section class="roadmap">
        <h2>Coming later</h2>
        <p class="roadmap__lede">
          Twitch comes first until it feels finished. After that, these get
          added one at a time.
        </p>
        <ul class="roadmap__list">
          <li>
            <Icon name="layers" class="roadmap__icon" />
            <p>
              YouTube and Kick chat merged in with Twitch, so you can stream to
              all three and read a single chat. A timeout lands on whichever
              platform that person is on.
            </p>
          </li>
          <li>
            <Icon name="cast" class="roadmap__icon" />
            <p>
              A way to put chat on your stream in OBS straight from the app,
              with every platform in one feed and no widget service in between.
            </p>
          </li>
          <li>
            <Icon name="puzzle" class="roadmap__icon" />
            <p>Plugins, for the things we did not think of.</p>
          </li>
          <li>
            <Icon name="laptop" class="roadmap__icon" />
            <p>Mac and Linux versions, from the same download page.</p>
          </li>
        </ul>
      </section>

      <section class="cta">
        <div class="cta__beam" aria-hidden="true" />
        <h2>Try it on tonight's stream.</h2>
        <p>
          Install, sign in with Twitch, open a channel. If something is off,{" "}
          <a
            href="https://github.com/ImpulseB23/Prismoid/issues"
            class="inline-link"
            target="_blank"
            rel="noopener"
          >
            say so
          </a>
          .
        </p>
        <Download platform={platform()} />
      </section>
    </>
  );
}
