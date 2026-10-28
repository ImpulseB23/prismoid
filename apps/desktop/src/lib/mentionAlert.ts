// Gets attention when chat mentions the user while the window is in the
// background: a short chime and a flashing taskbar button. Bursts of
// mentions ping once, not once per message.

export const ALERT_GAP_MS = 3000;

export interface MentionAlertDeps {
  focused: () => boolean;
  flash: () => Promise<void>;
  chime: () => void;
  now?: () => number;
}

export interface MentionAlert {
  /** Call for each new message that mentions the user. */
  notify: () => void;
}

export function createMentionAlert(deps: MentionAlertDeps): MentionAlert {
  const now = deps.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  return {
    notify: () => {
      if (deps.focused()) return;
      const t = now();
      if (t - last < ALERT_GAP_MS) return;
      last = t;
      deps.chime();
      deps.flash().catch((err: unknown) => console.error("flash window", err));
    },
  };
}

let audio: AudioContext | null = null;

function sharedContext(): AudioContext {
  audio ??= new AudioContext();
  return audio;
}

/** Two short rising notes, made on the fly so no sound file ships. */
export function playChime(ctx: AudioContext = sharedContext()): void {
  const start = ctx.currentTime;
  for (const [offset, freq] of [
    [0, 880],
    [0.11, 1320],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + offset);
    osc.stop(start + offset + 0.18);
  }
}
