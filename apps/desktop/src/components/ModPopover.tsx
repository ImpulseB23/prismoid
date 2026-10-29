// The timeout picker and the warning reason box, opened from a message's
// hover bar or right-click menu. Mounted once next to the context menu.

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  closeModPopover,
  modPopover,
  type ModPopover as Popover,
} from "../stores/modPopoverStore";
import { MAX_TIMEOUT_SECONDS } from "../stores/settingsStore";
import { formatSeconds } from "../lib/slashCommands";
import { warnNeedsReconnect } from "../stores/authStore";
import TwitchReconnect from "./TwitchReconnect";

const EDGE_GAP = 6;
const MAX_REASON = 500;

export const TIMEOUT_UNITS = [
  { label: "seconds", seconds: 1 },
  { label: "minutes", seconds: 60 },
  { label: "hours", seconds: 3600 },
  { label: "days", seconds: 86_400 },
] as const;

/** Seconds for a custom length, or null when Twitch would refuse it. */
export function customSeconds(amount: string, unit: number): number | null {
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1) return null;
  const seconds = n * unit;
  return seconds <= MAX_TIMEOUT_SECONDS ? seconds : null;
}

const TimeoutForm: Component<{
  open: Extract<Popover, { kind: "timeout" }>;
}> = (props) => {
  const [amount, setAmount] = createSignal("10");
  const [unit, setUnit] = createSignal(60);
  const seconds = () => customSeconds(amount(), unit());

  const pick = (s: number) => {
    closeModPopover();
    props.open.submit(s);
  };

  return (
    <form
      class="mod-pop__body"
      onSubmit={(e) => {
        e.preventDefault();
        const s = seconds();
        if (s !== null) pick(s);
      }}
    >
      <div class="mod-pop__presets">
        <For each={props.open.presets}>
          {(s) => (
            <button
              type="button"
              class="mod-pop__preset"
              onClick={() => pick(s)}
            >
              {formatSeconds(s)}
            </button>
          )}
        </For>
      </div>
      <div class="mod-pop__custom">
        <input
          class="mod-pop__input mod-pop__amount"
          type="number"
          min="1"
          inputMode="numeric"
          aria-label="Length"
          value={amount()}
          onInput={(e) => setAmount(e.currentTarget.value)}
        />
        <select
          class="modes__select"
          aria-label="Unit"
          value={unit()}
          onChange={(e) => setUnit(Number(e.currentTarget.value))}
        >
          <For each={TIMEOUT_UNITS}>
            {(u) => <option value={u.seconds}>{u.label}</option>}
          </For>
        </select>
        <button
          type="submit"
          class="btn btn--outline mod-pop__go"
          disabled={seconds() === null}
        >
          Timeout
        </button>
      </div>
    </form>
  );
};

const WarnForm: Component<{ open: Extract<Popover, { kind: "warn" }> }> = (
  props,
) => {
  const [reason, setReason] = createSignal("");
  const ready = () => reason().trim().length > 0;

  return (
    <form
      class="mod-pop__body"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready()) return;
        closeModPopover();
        props.open.submit(reason().trim());
      }}
    >
      <input
        class="mod-pop__input"
        type="text"
        maxLength={MAX_REASON}
        placeholder="Why? They see this before they can chat again"
        aria-label="Reason"
        value={reason()}
        onInput={(e) => setReason(e.currentTarget.value)}
      />
      <button
        type="submit"
        class="btn btn--outline mod-pop__go"
        disabled={!ready()}
      >
        Warn
      </button>
    </form>
  );
};

const ModPopover: Component = () => {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref && e.target instanceof Node && ref.contains(e.target)) return;
      closeModPopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModPopover();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", closeModPopover);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", closeModPopover);
    });
  });

  // Kept on screen once its size is known, with the first field focused.
  createEffect(() => {
    const open = modPopover();
    if (!open || !ref) return;
    const rect = ref.getBoundingClientRect();
    const left = Math.min(open.x, window.innerWidth - rect.width - EDGE_GAP);
    const top = Math.min(open.y, window.innerHeight - rect.height - EDGE_GAP);
    ref.style.left = `${Math.max(EDGE_GAP, left)}px`;
    ref.style.top = `${Math.max(EDGE_GAP, top)}px`;
    ref.querySelector<HTMLElement>("input, button")?.focus();
  });

  // Keyed, so each popup starts with fresh fields.
  return (
    <Show when={modPopover()} keyed>
      {(open) => (
        <div
          ref={(el) => (ref = el)}
          class="mod-pop"
          role="dialog"
          aria-label={`${open.kind === "timeout" ? "Timeout" : "Warn"} ${open.target}`}
          style={{ left: `${open.x}px`, top: `${open.y}px` }}
        >
          <div class="mod-pop__title">
            {open.kind === "timeout" ? "Timeout" : "Warn"} {open.target}
          </div>
          {open.kind === "timeout" ? (
            <TimeoutForm open={open} />
          ) : (
            <Show
              when={!warnNeedsReconnect()}
              fallback={
                <TwitchReconnect
                  title="Warn needs one more permission"
                  hint="Reconnect Twitch once and you can warn people from here."
                />
              }
            >
              <WarnForm open={open} />
            </Show>
          )}
        </div>
      )}
    </Show>
  );
};

export default ModPopover;
