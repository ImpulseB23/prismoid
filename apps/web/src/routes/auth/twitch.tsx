// Twitch redirects here after the user authorizes prismoid. The token sits
// in the URL fragment, which only this page can read, so it is handed to
// the desktop app through its prismoid:// link and scrubbed from the
// address bar and history.

import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { Show, createSignal, onMount } from "solid-js";
import { deepLinkFor } from "~/lib/twitchDeepLink";
import "./twitch.css";

type Phase = "pending" | "opening" | "nothing";

export default function TwitchAuth() {
  const [phase, setPhase] = createSignal<Phase>("pending");
  const [link, setLink] = createSignal<string | null>(null);

  onMount(() => {
    const target = deepLinkFor(location.hash, location.search);
    history.replaceState(null, "", location.pathname);
    if (!target) {
      setPhase("nothing");
      return;
    }
    setLink(target);
    setPhase("opening");
    location.assign(target);
  });

  return (
    <>
      <Title>Sign-in - prismoid</Title>
      <Meta name="robots" content="noindex" />
      <div class="handoff">
        <Show when={phase() === "pending"}>
          <h1>Finishing sign-in</h1>
          <p>One moment.</p>
        </Show>
        <Show when={phase() === "opening"}>
          <h1>Opening prismoid</h1>
          <p>
            Your browser may ask for permission to open it. Once prismoid is
            back in front, you can close this tab.
          </p>
          <a href={link() ?? "#"} class="btn btn-primary">
            Open prismoid
          </a>
        </Show>
        <Show when={phase() === "nothing"}>
          <h1>Nothing to finish here</h1>
          <p>Start the sign-in from inside prismoid.</p>
          <A href="/" class="btn btn-outline">
            Back to home
          </A>
        </Show>
      </div>
    </>
  );
}
