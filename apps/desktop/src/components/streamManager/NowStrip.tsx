// The stream right now, across the top of the stream manager: live or
// offline with the uptime clock, who is watching, the next ad with snooze
// and run controls when ads are on, and the timeline rail underneath.

import { Component, Show } from "solid-js";
import { COMMERCIAL_MAX_SECS, DEFAULT_COMMERCIAL_SECS } from "../../lib/ads";
import { formatAdLength, formatClock } from "../../lib/streamInfo";
import { formatChannelError, type StreamInfo } from "../../lib/twitchChannel";
import {
  adSchedule,
  commercialError,
  commercialPending,
  commercialReadyAt,
  currentAdBreak,
  snoozeError,
  snoozeNextAd,
  snoozePending,
  startCommercial,
} from "../../stores/adStore";
import { streamLog } from "../../stores/streamLogStore";
import Timeline from "./Timeline";

const NowStrip: Component<{
  info: StreamInfo | null;
  now: number;
  /** Ads are turned on and granted. */
  adsReady: boolean;
}> = (props) => {
  const start = () => {
    const at = props.info?.is_live ? props.info.started_at : null;
    if (at === null) return null;
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? null : ms;
  };

  const nextAd = () => {
    const s = props.adsReady ? adSchedule() : null;
    return s && s.next_ad_at !== null
      ? { at: s.next_ad_at, secs: s.duration }
      : null;
  };

  const breakLeft = () => {
    const ad = props.adsReady ? currentAdBreak() : null;
    const left = ad
      ? ad.started_at + ad.duration_seconds * 1000 - props.now
      : 0;
    return left > 0 ? left : null;
  };

  const watching = () => {
    const info = props.info;
    return info?.is_live && info.viewer_count !== null
      ? { count: info.viewer_count }
      : null;
  };

  // The break Twitch has lined up, or a 90 second one when none is.
  const runLength = () =>
    Math.min(nextAd()?.secs ?? DEFAULT_COMMERCIAL_SECS, COMMERCIAL_MAX_SECS);

  const cooling = () => (commercialReadyAt() ?? 0) > props.now;
  const adError = () => snoozeError() ?? commercialError();

  return (
    <section class="sm-now" aria-label="Your stream right now">
      <div class="sm-now__row">
        <div class="sm-stat">
          <span
            class="sm-status"
            classList={{ "sm-status--live": props.info?.is_live === true }}
          >
            <span class="sm-status__dot" aria-hidden="true" />
            {props.info?.is_live ? "Live" : "Offline"}
          </span>
          <Show when={start()}>
            {(s) => (
              <span class="sm-stat__value sm-stat__value--big">
                {formatClock(props.now - s())}
              </span>
            )}
          </Show>
        </div>
        <Show when={watching()}>
          {(w) => (
            <div class="sm-stat">
              <span class="sm-stat__label">Watching</span>
              <span class="sm-stat__value">{w().count.toLocaleString()}</span>
            </div>
          )}
        </Show>
        <Show when={props.adsReady && props.info?.is_live}>
          <div class="sm-now__ad">
            <Show
              when={breakLeft()}
              fallback={
                <Show when={nextAd()}>
                  {(next) => (
                    <div class="sm-stat sm-stat--end">
                      <span class="sm-stat__label">
                        Next ad, {formatAdLength(next().secs)}
                      </span>
                      <span class="sm-stat__value">
                        {next().at > props.now
                          ? `in ${formatClock(next().at - props.now)}`
                          : "any moment"}
                      </span>
                    </div>
                  )}
                </Show>
              }
            >
              {(left) => (
                <div class="sm-stat sm-stat--end">
                  <span class="sm-stat__label">Ad running</span>
                  <span class="sm-stat__value">{formatClock(left())} left</span>
                </div>
              )}
            </Show>
            <button
              type="button"
              class="btn btn--small"
              disabled={
                snoozePending() ||
                nextAd() === null ||
                adSchedule()?.snooze_count === 0
              }
              onClick={() => void snoozeNextAd()}
            >
              Snooze 5 min
            </button>
            <button
              type="button"
              class="btn btn--small btn--primary"
              disabled={
                commercialPending() || cooling() || breakLeft() !== null
              }
              onClick={() => void startCommercial(runLength())}
            >
              Run {formatAdLength(runLength())} ad
            </button>
          </div>
        </Show>
      </div>
      <Show when={props.adsReady && adError()}>
        {(err) => (
          <div class="dialog__error sm-now__error" role="alert">
            {formatChannelError(err())}
          </div>
        )}
      </Show>
      <Show when={start()}>
        {(s) => (
          <Timeline
            start={s()}
            now={props.now}
            entries={streamLog()}
            nextAd={nextAd()}
          />
        )}
      </Show>
    </section>
  );
};

export default NowStrip;
