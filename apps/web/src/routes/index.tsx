import { Match, Show, Switch } from "solid-js";
import { getRequestEvent } from "solid-js/web";
import { createAsync, query } from "@solidjs/router";
import { Title, Meta } from "@solidjs/meta";
import GithubPreview from "~/components/GithubPreview";
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
        class="btn btn-primary btn-hero"
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
          There is no {PLATFORM_NAMES[target()]} app. prismoid is a chat window
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

// A still of the app, drawn in markup so it stays sharp at any size and
// never goes stale next to a screenshot of an older build.
function AppMock() {
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
        <div class="mock__msg mock__msg--old">
          <span class="mock__badge mock__badge--sub" />
          <span class="mock__name" style="color:#1e90ff">
            Tricklord
          </span>
          <span>
            he is NOT reading chat <span class="mock__emote" />
          </span>
        </div>
        <div class="mock__msg mock__msg--old">
          <span class="mock__badge mock__badge--vip" />
          <span class="mock__name" style="color:#ff69b4">
            supibot
          </span>
          <span>@brayanx2, reminder from yourself (1m, 5s ago): $fish</span>
        </div>
        <div class="mock__divider">
          <span>earlier, before you opened the tab</span>
        </div>
        <div class="mock__msg">
          <span class="mock__badge mock__badge--mod" />
          <span class="mock__name" style="color:#00ff7f">
            nymn
          </span>
          <span>
            pepeLaugh <span class="mock__emote mock__emote--b" /> he found the
            setting
          </span>
        </div>
        <div class="mock__notice">
          <b>nymn</b> timed out <b>spammer_4421</b> for 10m: links
        </div>
        <div class="mock__msg">
          <span class="mock__badge mock__badge--sub" />
          <span class="mock__name" style="color:#daa520">
            kebabloverr
          </span>
          <span>
            how is chat this fast <span class="mock__emote mock__emote--c" />
          </span>
        </div>
        <div class="mock__msg mock__msg--deleted">
          <span class="mock__name" style="color:#8f8f8f">
            spammer_4421
          </span>
          <span>FREE FOLLOWERS at bit dot ly slash</span>
        </div>
        <div class="mock__msg">
          <span class="mock__badge mock__badge--mod" />
          <span class="mock__name" style="color:#8b5fc8">
            you
          </span>
          <span>
            <span class="mock__mention">@kebabloverr</span> it skips the website
          </span>
        </div>
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
        prismoid - the Twitch chat window the site should have shipped
      </Title>
      <Meta
        name="description"
        content="A desktop chat client for Twitch. Tabs, chat history that survives a restart, mod actions you can see, 7TV, BTTV and FFZ emotes. Free, open source, 14 MB."
      />
      <Meta
        property="og:title"
        content="prismoid - the Twitch chat window the site should have shipped"
      />
      <Meta
        property="og:description"
        content="Tabs, history, mod actions you can see, your emotes. Free, open source, 14 MB."
      />
      <Meta property="og:image" content="/icons/icon-512.png" />
      <Meta property="og:url" content="https://prismoid.org" />
      <Meta name="twitter:card" content="summary" />

      <section class="hero">
        <div class="hero__copy">
          <h1>prismoid</h1>
          <p class="tagline">
            Twitch chat is the best part of Twitch and the worst part of the
            Twitch website.
          </p>
          <p class="lede">
            prismoid is the chat window the site should have shipped. Tabs,
            history, mod actions you can see, your emotes. Free, open source,
            about 14 MB.
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
        </div>
        <AppMock />
      </section>

      <section class="moments">
        <div class="moment">
          <h2>You tab back and chat is 400 messages ahead.</h2>
          <p>
            Scroll up as far as you like. prismoid keeps every channel's chat on
            your disk and puts it back when you open the channel, restart or
            not. First time in a channel? It pulls the last few hundred lines
            anyway, so you never arrive to an empty window.
          </p>
        </div>
        <div class="moment">
          <h2>Someone got timed out and nobody knows why.</h2>
          <p>
            Timeouts, bans and deletions show up in chat as they happen, in
            every channel. Where you moderate, you also get who did it and the
            reason, and you can act straight from the message: timeout, ban,
            delete, done.
          </p>
        </div>
        <div class="moment">
          <h2>Five channels, five windows.</h2>
          <p>
            Tabs. Ctrl+Tab between them, unread counts on the ones you're not
            looking at, and all of it on one connection so Twitch never cuts you
            off for having too many open.
          </p>
        </div>
        <div class="moment">
          <h2>Your emotes, in your chat.</h2>
          <p>
            7TV, BTTV and FFZ next to Twitch's own, badges and replies drawn the
            way you expect. Right-click any emote to see what it is and where it
            came from.
          </p>
        </div>
        <div class="moment">
          <h2>Watching in the browser anyway?</h2>
          <p>
            Turn on follow mode and prismoid switches to whatever Twitch channel
            is in your front browser window. Pin it on top of the stream and
            forget the site's chat exists.
          </p>
        </div>
      </section>

      <section class="facts">
        <span>about 14 MB</span>
        <span>no bundled browser</span>
        <span>no cloud, no account with us</span>
        <span>GPL-3.0</span>
        <span>Windows now, macOS and Linux later</span>
      </section>

      <section class="why">
        <h2>Small on purpose.</h2>
        <div class="why__grid">
          <div class="why__item">
            <h3>14 MB, not 300.</h3>
            <p>
              prismoid draws its window with the WebView2 that Windows already
              ships, so there is no second copy of a browser on your disk and
              the download is the size of a few photos.
            </p>
          </div>
          <div class="why__item">
            <h3>Three small parts.</h3>
            <p>
              The window, a Rust core that parses and scans every message, and a
              separate process that holds the network connections. If a
              connection dies, the core restarts that process in seconds and the
              window never notices.
            </p>
          </div>
          <div class="why__item">
            <h3>Nothing in between.</h3>
            <p>
              Your machine talks to Twitch directly. No relay, no account with
              us, nothing to subscribe to, and your sign-in stays in Windows
              Credential Manager where it belongs.
            </p>
          </div>
        </div>
      </section>

      <section class="roadmap">
        <h2>Where this is going.</h2>
        <p class="roadmap__lede">
          Twitch first, until it is right. These are planned, not promised, and
          they land one at a time.
        </p>
        <ul class="roadmap__list">
          <li>
            <strong>Twitch, YouTube and Kick in one feed.</strong> Both are in
            the code and switched off until they are as good as Twitch. One
            window, one scroll, and a timeout on a YouTube message hits YouTube.
          </li>
          <li>
            <strong>A chat overlay for OBS.</strong> A browser source served by
            the app on your own machine, with every platform in one feed and no
            widget service in the middle.
          </li>
          <li>
            <strong>Stream controls.</strong> Title, category and going live
            from the same window you moderate in.
          </li>
          <li>
            <strong>Extensions.</strong> A plugin API for the things we did not
            think of.
          </li>
          <li>
            <strong>macOS and Linux.</strong> Same app, same download page.
          </li>
        </ul>
      </section>

      <section class="cta">
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
