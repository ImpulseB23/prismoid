// Twitch redirects here after the user answers its Authorize page. A
// granted token sits in the URL fragment, which only this page can read,
// so it is handed to the desktop app through its prismoid:// link and
// scrubbed from the address bar and history. Nothing is sent to a server.

import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { Match, Switch, createSignal, onMount } from "solid-js";
import { deepLinkFor } from "~/lib/twitchDeepLink";
import "./twitch.css";

type Phase = "pending" | "approved" | "declined" | "nothing";

const TwitchMark = () => (
  <svg viewBox="0 0 24 28" aria-hidden="true">
    <path
      fill="currentColor"
      d="M2 0 0 5v19h6v4h3.5l4-4H19l5-5V0H2zm20 18-3.5 3.5H13l-3.5 3.5V21.5H4V2h18v16z"
    />
    <path fill="currentColor" d="M16.5 6.5h2v6h-2zM11 6.5h2v6h-2z" />
  </svg>
);

const Check = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="m5 12.5 4.5 4.5L19 7.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

const Cross = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="m7 7 10 10M17 7 7 17"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
    />
  </svg>
);

const Lock = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect
      x="5"
      y="11"
      width="14"
      height="9"
      rx="2"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
    />
    <path
      d="M8 11V8a4 4 0 0 1 8 0v3"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
    />
  </svg>
);

export default function TwitchAuth() {
  const [phase, setPhase] = createSignal<Phase>("pending");
  const [link, setLink] = createSignal<string | null>(null);

  onMount(() => {
    const declined = new URLSearchParams(location.search).has("error");
    const target = deepLinkFor(location.hash, location.search);
    history.replaceState(null, "", location.pathname);
    if (!target) {
      setPhase("nothing");
      return;
    }
    setLink(target);
    setPhase(declined ? "declined" : "approved");
    location.assign(target);
  });

  return (
    <>
      <Title>Sign in with Twitch - prismoid</Title>
      <Meta name="robots" content="noindex" />
      <div class="handoff">
        <div class="handoff__card">
          <div
            class="handoff__pair"
            classList={{
              "handoff__pair--ok": phase() === "approved",
              "handoff__pair--no": phase() === "declined",
            }}
          >
            <span class="handoff__mark handoff__mark--app">
              <img src="/icons/nav-icon-light.svg" alt="prismoid" />
            </span>
            <span class="handoff__link">
              <Switch fallback={<span class="handoff__dots" />}>
                <Match when={phase() === "approved"}>
                  <Check />
                </Match>
                <Match when={phase() === "declined"}>
                  <Cross />
                </Match>
              </Switch>
            </span>
            <span class="handoff__mark handoff__mark--twitch">
              <TwitchMark />
            </span>
          </div>

          <Switch>
            <Match when={phase() === "pending"}>
              <h1>Finishing sign-in</h1>
              <p>One moment.</p>
            </Match>
            <Match when={phase() === "approved"}>
              <h1>Twitch approved prismoid</h1>
              <p>
                Your browser will ask to open prismoid. Choose Open and you are
                signed in. You can close this tab afterwards.
              </p>
              <a href={link() ?? "#"} class="btn btn-primary handoff__open">
                Open prismoid
              </a>
              <p class="handoff__hint">
                Nothing happened? Make sure prismoid is installed and open, then
                press the button again.
              </p>
            </Match>
            <Match when={phase() === "declined"}>
              <h1>Sign-in cancelled</h1>
              <p>
                Twitch did not give prismoid access. To try again, go back to
                the app and choose Sign in with Twitch.
              </p>
              <a href={link() ?? "#"} class="btn btn-outline handoff__open">
                Back to prismoid
              </a>
            </Match>
            <Match when={phase() === "nothing"}>
              <h1>Nothing to finish here</h1>
              <p>
                This page completes a sign-in started from the prismoid app.
                Open the app and choose Sign in with Twitch.
              </p>
              <A href="/" class="btn btn-outline handoff__open">
                Back to home
              </A>
            </Match>
          </Switch>

          <p class="handoff__privacy">
            <Lock />
            Your sign-in goes from Twitch straight to the app on this computer.
            It is never sent to prismoid.org. Your password stays with Twitch.
          </p>
        </div>
      </div>
    </>
  );
}
