// Overlay for the welcome tour: dims the window, rings the control the
// current step is about, and keeps the step card clear of it.

import {
  Component,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  TOUR_STEPS,
  finishTour,
  nextTourStep,
  previousTourStep,
  tourStep,
} from "../stores/tourStore";
import { settings, updateSettings } from "../stores/settingsStore";

interface Ring {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6;

const Tour: Component = () => {
  const [ring, setRing] = createSignal<Ring | null>(null);
  let cardRef: HTMLDivElement | undefined;

  const current = () => {
    const s = tourStep();
    return s === null ? null : TOUR_STEPS[s];
  };

  const measure = () => {
    const target = current()?.target;
    const el = target
      ? document.querySelector<HTMLElement>(`[data-tour="${target}"]`)
      : null;
    if (!el) {
      setRing(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRing({
      top: r.top - PAD,
      left: r.left - PAD,
      width: r.width + PAD * 2,
      height: r.height + PAD * 2,
    });
  };

  createEffect(() => {
    if (tourStep() === null) return;
    measure();
    queueMicrotask(() => cardRef?.focus());
    window.addEventListener("resize", measure);
    onCleanup(() => window.removeEventListener("resize", measure));
  });

  // The card sits at the bottom unless the ring is down there.
  const cardAtTop = () => {
    const r = ring();
    return r !== null && r.top + r.height / 2 > window.innerHeight / 2;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void finishTour();
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      nextTourStep();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      previousTourStep();
    }
  };

  const run = (p: Promise<void>) =>
    p.catch((err: unknown) => console.error("tour setting", err));

  return (
    <Show when={current()}>
      {(step) => (
        <div class="tour" onKeyDown={onKey}>
          <Show
            when={ring()}
            fallback={<div class="tour__shade" aria-hidden="true" />}
          >
            {(r) => (
              <div
                class="tour__ring"
                aria-hidden="true"
                style={{
                  top: `${r().top}px`,
                  left: `${r().left}px`,
                  width: `${r().width}px`,
                  height: `${r().height}px`,
                }}
              />
            )}
          </Show>
          <div
            class="tour__card"
            classList={{ "tour__card--top": cardAtTop() }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tour-title"
            tabIndex={-1}
            ref={(el) => (cardRef = el)}
          >
            <div class="tour__progress" aria-hidden="true">
              {TOUR_STEPS.map((_, i) => (
                <span classList={{ "tour__dot--on": i === tourStep() }} />
              ))}
            </div>
            <h2 id="tour-title">{step().title}</h2>
            <p>{step().body}</p>
            <Show when={step().toggles}>
              <label class="tour__toggle">
                <span>
                  <strong>Follow my browser</strong>
                  Switch to the Twitch channel open in your browser
                </span>
                <input
                  type="checkbox"
                  class="switch"
                  checked={settings().followBrowser}
                  onChange={(e) =>
                    run(
                      updateSettings({
                        followBrowser: e.currentTarget.checked,
                      }),
                    )
                  }
                />
              </label>
              <label class="tour__toggle">
                <span>
                  <strong>Keep on top</strong>
                  Stay above your game or stream preview
                </span>
                <input
                  type="checkbox"
                  class="switch"
                  checked={settings().alwaysOnTop}
                  onChange={(e) =>
                    run(
                      updateSettings({ alwaysOnTop: e.currentTarget.checked }),
                    )
                  }
                />
              </label>
            </Show>
            <div class="tour__actions">
              <Show
                when={tourStep() !== TOUR_STEPS.length - 1}
                fallback={<span />}
              >
                <button
                  type="button"
                  class="tour__skip"
                  onClick={() => void finishTour()}
                >
                  Skip tour
                </button>
              </Show>
              <div class="tour__nav">
                <Show when={(tourStep() ?? 0) > 0}>
                  <button
                    type="button"
                    class="btn btn--outline"
                    onClick={previousTourStep}
                  >
                    Back
                  </button>
                </Show>
                <button
                  type="button"
                  class="btn btn--primary"
                  onClick={nextTourStep}
                >
                  {tourStep() === TOUR_STEPS.length - 1 ? "Done" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default Tour;
