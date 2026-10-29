// The stream manager as a curtain over the chat: the stream right now and
// its timeline on top, the sections as tabs, and a handle along the bottom
// edge to pull it longer or shorter. Chat stays live underneath.

import {
  Component,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
} from "solid-js";
import { liveSince } from "../../lib/streamInfo";
import type { StreamInfo } from "../../lib/twitchChannel";
import { scopeGroupReady } from "../../stores/authStore";
import {
  STREAM_MANAGER_HEIGHT,
  settings,
  updateSettings,
} from "../../stores/settingsStore";
import {
  ownChannelMonetized,
  setStreamManagerTab,
  streamManagerTab,
} from "../../stores/streamManagerPanelStore";
import AdsSection from "./AdsSection";
import AffiliateGate from "./AffiliateGate";
import NowStrip from "./NowStrip";
import PollsSection from "./PollsSection";
import QuickActions from "./QuickActions";
import RunningNow from "./RunningNow";
import ScopeGroupCard from "./ScopeGroupCard";
import SectionTabs, { panelId, tabId } from "./SectionTabs";
import StreamSetup from "./StreamSetup";

const KEY_STEP = 0.05;

const clamp = (v: number) =>
  Math.min(STREAM_MANAGER_HEIGHT.max, Math.max(STREAM_MANAGER_HEIGHT.min, v));

const Curtain: Component<{
  info: StreamInfo | null;
  closing: boolean;
  onClosed: () => void;
}> = (props) => {
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  const [height, setHeight] = createSignal(settings().streamManagerHeight);
  const keep = (v: number) =>
    void updateSettings({ streamManagerHeight: v }).catch((e: unknown) =>
      console.error("save stream manager height", e),
    );

  let frameRef: HTMLDivElement | undefined;
  const fromPointer = (e: PointerEvent) => {
    const area = frameRef?.parentElement?.getBoundingClientRect();
    if (!area || area.height === 0) return;
    setHeight(clamp((e.clientY - area.top) / area.height));
  };

  const onKey = (e: KeyboardEvent) => {
    const next =
      e.key === "ArrowUp"
        ? height() - KEY_STEP
        : e.key === "ArrowDown"
          ? height() + KEY_STEP
          : e.key === "Home"
            ? STREAM_MANAGER_HEIGHT.min
            : e.key === "End"
              ? STREAM_MANAGER_HEIGHT.max
              : null;
    if (next === null) return;
    e.preventDefault();
    setHeight(clamp(next));
    keep(height());
  };

  return (
    <div
      class="sm-curtain-frame"
      data-stream-manager
      ref={(el) => (frameRef = el)}
      style={{ height: `${height() * 100}%` }}
    >
      <section
        class="sm-curtain"
        classList={{ "sm-curtain--closing": props.closing }}
        aria-label="Stream manager"
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && props.closing) props.onClosed();
        }}
      >
        <NowStrip
          info={props.info}
          now={now()}
          adsReady={scopeGroupReady("ads") && ownChannelMonetized() === true}
        />
        <SectionTabs
          current={streamManagerTab()}
          onPick={setStreamManagerTab}
        />
        <div
          class="sm-curtain__body"
          role="tabpanel"
          id={panelId(streamManagerTab())}
          aria-labelledby={tabId(streamManagerTab())}
        >
          <Show
            when={scopeGroupReady("stream")}
            fallback={<ScopeGroupCard group="stream" />}
          >
            <Switch>
              <Match when={streamManagerTab() === "live"}>
                <div class="sm-cols">
                  <div class="sm-col sm-col--main">
                    <StreamSetup />
                  </div>
                  <div class="sm-col">
                    <QuickActions live={props.info?.is_live === true} />
                    <RunningNow now={now()} />
                  </div>
                </div>
              </Match>
              <Match when={streamManagerTab() === "ads"}>
                <AffiliateGate monetized={ownChannelMonetized()} what="Ads">
                  <AdsSection now={now()} since={liveSince(props.info)} />
                </AffiliateGate>
              </Match>
              <Match when={streamManagerTab() === "polls"}>
                <AffiliateGate
                  monetized={ownChannelMonetized()}
                  what="Polls and predictions"
                >
                  <PollsSection now={now()} />
                </AffiliateGate>
              </Match>
            </Switch>
          </Show>
        </div>
        <div
          class="sm-curtain__handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize stream manager"
          aria-valuemin={Math.round(STREAM_MANAGER_HEIGHT.min * 100)}
          aria-valuemax={Math.round(STREAM_MANAGER_HEIGHT.max * 100)}
          aria-valuenow={Math.round(height() * 100)}
          tabIndex={0}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
          }}
          onPointerUp={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            e.currentTarget.releasePointerCapture(e.pointerId);
            keep(height());
          }}
        />
      </section>
    </div>
  );
};

export default Curtain;
