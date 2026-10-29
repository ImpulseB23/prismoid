// One-tap actions on the user's own stream. Markers use the base stream
// manager permission; clips, shoutouts, announcements and Shield Mode are
// opt-in, so until they are on a card explains them in their place.

import {
  Component,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  QUICK_ACTION_LIMITS,
  createClip,
  createMarker,
  getClip,
  getShieldMode,
  setShieldMode,
  type ShieldMode,
} from "../../lib/quickActions";
import { formatClock } from "../../lib/streamInfo";
import { formatChannelError } from "../../lib/twitchChannel";
import { scopeGroupReady } from "../../stores/authStore";
import { recordStreamEvent } from "../../stores/streamLogStore";
import { AnnounceForm, ShoutoutForm } from "./QuickForms";
import ScopeGroupCard from "./ScopeGroupCard";

const CLIP_POLL_MS = 5000;

type Clip =
  | { state: "making" }
  | { state: "ready"; url: string }
  | { state: "failed" };

const Tile: Component<{
  title: string;
  hint: string;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    class="sm-qa"
    classList={{
      "sm-qa--on": props.pressed === true || props.expanded === true,
    }}
    disabled={props.disabled}
    aria-pressed={props.pressed}
    aria-expanded={props.expanded}
    onClick={() => props.onClick()}
  >
    <strong>{props.title}</strong>
    <span>{props.hint}</span>
  </button>
);

const QuickActions: Component<{ live: boolean }> = (props) => {
  const ready = () => scopeGroupReady("live_actions");
  const [panel, setPanel] = createSignal<"shoutout" | "announce" | null>(null);
  const [notice, setNotice] = createSignal<{
    text: string;
    error: boolean;
  } | null>(null);
  const [markerBusy, setMarkerBusy] = createSignal(false);
  const [shield, setShield] = createSignal<ShieldMode | null>(null);
  const [shieldBusy, setShieldBusy] = createSignal(false);
  const [clip, setClip] = createSignal<Clip | null>(null);

  const fail = (e: unknown) =>
    setNotice({ text: formatChannelError(e), error: true });
  const done = (text: string) => setNotice({ text, error: false });

  let disposed = false;
  let clipTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    clearTimeout(clipTimer);
  });

  let shieldGen = 0;
  createEffect(
    on(ready, (on) => {
      const gen = ++shieldGen;
      setShield(null);
      if (!on) return;
      getShieldMode().then(
        (s) => gen === shieldGen && setShield(s),
        (e: unknown) => gen === shieldGen && fail(e),
      );
    }),
  );

  const addMarker = async () => {
    setMarkerBusy(true);
    try {
      const marker = await createMarker();
      recordStreamEvent({
        kind: "marker",
        id: marker.id,
        at: marker.created_at,
        marker,
      });
      done(`Marker added at ${formatClock(marker.position_seconds * 1000)}.`);
    } catch (e) {
      fail(e);
    } finally {
      setMarkerBusy(false);
    }
  };

  const makeClip = async () => {
    clearTimeout(clipTimer);
    setClip({ state: "making" });
    setNotice(null);
    try {
      const created = await createClip();
      const deadline = Date.now() + QUICK_ACTION_LIMITS.clipProcessingMs;
      const check = async () => {
        if (disposed) return;
        try {
          if (await getClip(created.id)) {
            setClip({ state: "ready", url: created.edit_url });
          } else if (Date.now() >= deadline) {
            setClip({ state: "failed" });
          } else if (!disposed) {
            clipTimer = setTimeout(() => void check(), CLIP_POLL_MS);
          }
        } catch (e) {
          setClip(null);
          fail(e);
        }
      };
      clipTimer = setTimeout(() => void check(), CLIP_POLL_MS);
    } catch (e) {
      setClip(null);
      fail(e);
    }
  };

  const toggleShield = async () => {
    const current = shield();
    if (!current) return;
    setShieldBusy(true);
    try {
      setShield(await setShieldMode(!current.is_active));
    } catch (e) {
      fail(e);
    } finally {
      setShieldBusy(false);
    }
  };

  const toggle = (p: "shoutout" | "announce") =>
    setPanel((open) => (open === p ? null : p));

  const offline = (hint: string) => (props.live ? hint : "When you are live");

  const clipHint = (): string => {
    const c = clip();
    if (c?.state === "making") return "Making your clip";
    if (c?.state === "ready") return "Ready, make another";
    return offline("The last 30 seconds");
  };

  const clipUrl = () => {
    const c = clip();
    return c?.state === "ready" ? c.url : null;
  };

  const formDone = (text: string) => {
    setPanel(null);
    done(text);
  };

  return (
    <section class="sm-quick" aria-labelledby="sm-quick-title">
      <h2 id="sm-quick-title" class="sm-heading">
        Quick actions
      </h2>
      <div class="sm-qa-grid">
        <Tile
          title="Add marker"
          hint={offline("Find this moment in the VOD")}
          disabled={!props.live || markerBusy()}
          onClick={() => void addMarker()}
        />
        <Show when={ready()}>
          <Tile
            title="Clip that"
            hint={clipHint()}
            disabled={!props.live || clip()?.state === "making"}
            onClick={() => void makeClip()}
          />
          <Tile
            title="Shoutout"
            hint={offline("Send viewers to a channel")}
            disabled={!props.live}
            expanded={panel() === "shoutout"}
            onClick={() => toggle("shoutout")}
          />
          <Tile
            title="Announce"
            hint="A highlighted chat message"
            expanded={panel() === "announce"}
            onClick={() => toggle("announce")}
          />
          <Tile
            title="Shield Mode"
            hint={
              shield()?.is_active
                ? "On. Tap to lift it"
                : "Lock chat down in one tap"
            }
            disabled={shield() === null || shieldBusy()}
            pressed={shield()?.is_active ?? false}
            onClick={() => void toggleShield()}
          />
        </Show>
      </div>
      <Switch>
        <Match when={panel() === "shoutout" && ready()}>
          <ShoutoutForm onDone={formDone} />
        </Match>
        <Match when={panel() === "announce" && ready()}>
          <AnnounceForm onDone={formDone} />
        </Match>
      </Switch>
      <Show when={clipUrl()}>
        {(url) => (
          <div class="sm-note" role="status">
            Your clip is ready.
            <button
              type="button"
              class="sm-link"
              onClick={() =>
                void openUrl(url()).catch((e: unknown) =>
                  console.error("open clip", e),
                )
              }
            >
              Trim and title it on Twitch
            </button>
          </div>
        )}
      </Show>
      <Show when={clip()?.state === "failed"}>
        <div class="dialog__error" role="alert">
          Twitch could not finish that clip. Try again in a moment.
        </div>
      </Show>
      <Show when={notice()}>
        {(n) => (
          <div
            classList={{ "sm-note": !n().error, dialog__error: n().error }}
            role={n().error ? "alert" : "status"}
          >
            {n().text}
          </div>
        )}
      </Show>
      <Show when={!ready()}>
        <ScopeGroupCard group="live_actions" />
      </Show>
    </section>
  );
};

export default QuickActions;
