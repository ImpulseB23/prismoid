// Ads on the user's channel: the next break, snoozes, pre-roll free time,
// a break of any length on demand, and the breaks seen since Prismoid opened.
// Errors from snoozing and running ads show in the strip at the top,
// next to the same controls.

import { Component, For, Show, createSignal } from "solid-js";
import { COMMERCIAL_LENGTHS, DEFAULT_COMMERCIAL_SECS } from "../../lib/ads";
import { formatAdLength, formatClock, formatTime } from "../../lib/streamInfo";
import { formatChannelError } from "../../lib/twitchChannel";
import { scopeGroupReady } from "../../stores/authStore";
import {
  adSchedule,
  adScheduleError,
  commercialPending,
  commercialReadyAt,
  currentAdBreak,
  snoozeNextAd,
  snoozePending,
  startCommercial,
} from "../../stores/adStore";
import { streamLog, type LogEntry } from "../../stores/streamLogStore";
import ScopeGroupCard from "./ScopeGroupCard";

const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;

const Stat: Component<{ label: string; value: string; detail?: string }> = (
  props,
) => (
  <div class="sm-tile">
    <span class="sm-stat__label">{props.label}</span>
    <span class="sm-tile__value">{props.value}</span>
    <Show when={props.detail}>
      <span class="sm-hint">{props.detail}</span>
    </Show>
  </div>
);

const AdsSection: Component<{
  now: number;
  /** When the stream went live; null while offline. */
  since: number | null;
}> = (props) => {
  const [length, setLength] = createSignal(DEFAULT_COMMERCIAL_SECS);

  const nextAd = () => {
    const s = adSchedule();
    if (currentAdBreak()) return "Running now";
    if (!s || s.next_ad_at === null) return "None lined up";
    return s.next_ad_at > props.now
      ? `in ${formatClock(s.next_ad_at - props.now)}`
      : "any moment";
  };

  const snoozeDetail = () => {
    const at = adSchedule()?.snooze_refresh_at ?? null;
    return at !== null && at > props.now
      ? `Another one in ${minutes(at - props.now)}`
      : undefined;
  };

  const cooldown = () => {
    const at = commercialReadyAt();
    return at !== null && at > props.now ? at - props.now : null;
  };

  const breaks = () =>
    streamLog().filter(
      (e): e is Extract<LogEntry, { kind: "ad" }> =>
        e.kind === "ad" && (props.since === null || e.at >= props.since),
    );

  return (
    <Show
      when={scopeGroupReady("ads")}
      fallback={
        <section class="sm-section" aria-labelledby="sm-ads-title">
          <h2 id="sm-ads-title" class="sm-heading">
            Ads
          </h2>
          <ScopeGroupCard group="ads" />
        </section>
      }
    >
      <section class="sm-section" aria-labelledby="sm-ads-title">
        <h2 id="sm-ads-title" class="sm-heading">
          Ads
        </h2>
        <Show
          when={adSchedule()}
          fallback={
            <div class="sm-hint">
              {adScheduleError()
                ? formatChannelError(adScheduleError())
                : "Loading your ads"}
            </div>
          }
        >
          {(s) => (
            <div class="sm-tiles">
              <Stat
                label="Next ad"
                value={nextAd()}
                detail={
                  s().next_ad_at !== null
                    ? `${formatAdLength(s().duration)} break`
                    : undefined
                }
              />
              <Stat
                label="Snoozes left"
                value={String(s().snooze_count)}
                detail={snoozeDetail()}
              />
              <Stat
                label="Pre-roll free"
                value={
                  s().preroll_free_time > 0
                    ? minutes(s().preroll_free_time * 1000)
                    : "None"
                }
                detail="New viewers skip pre-rolls"
              />
            </div>
          )}
        </Show>

        <div class="sm-field">
          <span class="sm-label" id="sm-ad-length">
            Run an ad now
          </span>
          <div class="sm-seg" role="radiogroup" aria-labelledby="sm-ad-length">
            <For each={COMMERCIAL_LENGTHS}>
              {(secs) => (
                <label
                  class="sm-seg__option"
                  classList={{ "sm-seg__option--on": length() === secs }}
                >
                  <input
                    type="radio"
                    class="sm-sr"
                    name="sm-ad-length"
                    value={secs}
                    checked={length() === secs}
                    onChange={() => setLength(secs)}
                  />
                  {formatAdLength(secs)}
                </label>
              )}
            </For>
          </div>
          <div class="sm-actions">
            <button
              type="button"
              class="btn btn--small btn--primary"
              disabled={
                props.since === null ||
                commercialPending() ||
                cooldown() !== null ||
                currentAdBreak() !== null
              }
              onClick={() => void startCommercial(length())}
            >
              Run {formatAdLength(length())} ad
            </button>
            <button
              type="button"
              class="btn btn--small"
              disabled={
                snoozePending() ||
                !adSchedule()?.next_ad_at ||
                adSchedule()?.snooze_count === 0
              }
              onClick={() => void snoozeNextAd()}
            >
              Snooze 5 min
            </button>
          </div>
          <span class="sm-hint">
            <Show
              when={cooldown()}
              fallback={
                props.since === null
                  ? "Ads run while you are live."
                  : "Twitch needs 8 minutes between ads."
              }
            >
              {(left) =>
                `Twitch needs 8 minutes between ads. You can run another in ${formatClock(left())}.`
              }
            </Show>
          </span>
        </div>

        <div class="sm-list">
          <h3 class="sm-list__title">Ad breaks this stream</h3>
          <For
            each={breaks()}
            fallback={
              <div class="sm-hint">
                <Show
                  when={adSchedule()?.last_ad_at}
                  fallback="None yet since Prismoid opened."
                >
                  {(at) =>
                    `None since Prismoid opened. Twitch says the last one started at ${formatTime(at())}.`
                  }
                </Show>
              </div>
            }
          >
            {(e) => (
              <div class="sm-list__row">
                <span class="sm-list__main">
                  Ad break, {formatAdLength(e.ad.duration_seconds)}
                </span>
                <span class="sm-list__meta">
                  {e.ad.is_automatic ? "Automatic" : "You ran it"}
                </span>
                <span class="sm-list__time">{formatTime(e.at)}</span>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
};

export default AdsSection;
