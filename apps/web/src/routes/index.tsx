import { Title, Meta } from "@solidjs/meta";
import GithubPreview from "~/components/GithubPreview";
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

const TwitchIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
  </svg>
);

const YouTubeIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
  </svg>
);

const KickIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z" />
  </svg>
);

export default function Home() {
  return (
    <>
      <Title>prismoid - a better chat for Twitch</Title>
      <Meta
        name="description"
        content="A fast desktop chat client for Twitch viewers, moderators and streamers. Tabs, chat history, full moderation visibility and 7TV, BTTV and FFZ emotes. Runs on your machine, no account with us."
      />
      <Meta property="og:title" content="prismoid - a better chat for Twitch" />
      <Meta
        property="og:description"
        content="Tabs, chat history, moderation you can see, and your emotes everywhere. Free and open source."
      />
      <Meta property="og:image" content="/icons/icon-512.png" />
      <Meta property="og:url" content="https://prismoid.org" />
      <Meta name="twitter:card" content="summary" />

      <section class="hero">
        <h1>prismoid</h1>
        <p class="tagline">
          Twitch chat, done properly. Tabs for every channel, history that
          survives a restart, moderation you can actually see, and your emotes
          everywhere. For viewers, mods and streamers alike.
        </p>
        <div class="platforms">
          <span class="platform tw">
            <TwitchIcon /> Twitch
          </span>
          <span class="platform yt soon">
            <YouTubeIcon /> YouTube <em>soon</em>
          </span>
          <span class="platform kk soon">
            <KickIcon /> Kick <em>soon</em>
          </span>
        </div>
        <div class="hero-actions">
          <a href="/download/windows" class="btn btn-primary btn-hero">
            <WindowsIcon /> Download for Windows
          </a>
          <GithubPreview
            href="https://github.com/ImpulseB23/Prismoid"
            class="btn btn-outline btn-hero"
            target="_blank"
          >
            <GitHubIcon /> View source
          </GithubPreview>
        </div>
        <p class="download-note">
          Windows 10 and 11. Early build: it is not code signed yet, so Windows
          asks once before the first run. macOS and Linux follow.
        </p>
      </section>

      <section class="about">
        <p>
          prismoid is a free, open-source desktop client for live chat. Open any
          Twitch channel in a tab, read what was said before you arrived, keep
          up at any speed, and if you moderate, see every timeout, ban and
          deletion with who did it and why.
        </p>
        <p>
          No cloud, no account with us, no subscription. It runs entirely on
          your machine and talks to Twitch directly. Built with Rust, Go and
          TypeScript.
        </p>
      </section>

      <section class="features">
        <div class="section-label">Features</div>
        <div class="feature-grid">
          <div class="feature">
            <h3>Tabs and history</h3>
            <p>
              Keep several channels open and switch with a click or Ctrl+Tab.
              Every message is kept locally, so a channel opens with its recent
              chat instead of an empty window, even after a restart.
            </p>
          </div>
          <div class="feature">
            <h3>Moderation you can see</h3>
            <p>
              Timeouts, bans and deletions show up in chat as they happen. In
              channels you moderate you also get who did it and why, plus the
              tools to act from the message itself.
            </p>
          </div>
          <div class="feature">
            <h3>Emotes everywhere</h3>
            <p>
              7TV, BTTV and FFZ emotes next to Twitch's own, with a card for any
              emote you right-click. Badges, replies and notices render the way
              you expect.
            </p>
          </div>
          <div class="feature">
            <h3>Follows your browser</h3>
            <p>
              Turn on follow mode and the app switches to whichever Twitch
              channel is in your front browser window. Pin it on top and it
              behaves like the chat the stream should have had.
            </p>
          </div>
        </div>
      </section>

      <section class="roadmap">
        <div class="section-label">Coming later</div>
        <p>
          YouTube and Kick chat in the same window, including one feed that
          mixes all three for people who stream to more than one platform. The
          plumbing is in the app already; it is switched off in this release
          until it is as solid as Twitch.
        </p>
      </section>

      <section class="stack">
        <div class="section-label">Stack</div>
        <div class="stack-grid">
          <div class="stack-item">
            <h3>Rust</h3>
            <p>
              Tauri 2 shell, message processing, emote scanning via aho-corasick
            </p>
          </div>
          <div class="stack-item">
            <h3>Go</h3>
            <p>
              Sidecar for network I/O, WebSocket connections, OAuth, platform
              APIs
            </p>
          </div>
          <div class="stack-item">
            <h3>TypeScript</h3>
            <p>
              SolidJS frontend with virtual scrolling, emote rendering, mod UI
            </p>
          </div>
        </div>
      </section>

      <section class="cta">
        <h2>Built in the open</h2>
        <p>
          prismoid is GPL-3.0 and early. If something is off, say so:{" "}
          <a
            href="https://github.com/ImpulseB23/Prismoid/issues"
            class="inline-link"
            target="_blank"
            rel="noopener"
          >
            open an issue
          </a>{" "}
          or{" "}
          <a href="/contributing" class="inline-link">
            contribute
          </a>
          .
        </p>
      </section>
    </>
  );
}
