// 7TV name paints by Twitch user id. The host holds every paint the 7TV
// EventAPI has sent and who wears which; this mirrors it for rendering. A
// snapshot covers a webview that mounted late, events cover the rest.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { settings } from "./settingsStore";

export interface PaintStop {
  at: number;
  /** CSS #rrggbbaa. */
  color: string;
}

export interface PaintShadow {
  x: number;
  y: number;
  radius: number;
  color: string;
}

export interface Paint {
  id: string;
  name: string;
  function: "LINEAR_GRADIENT" | "RADIAL_GRADIENT" | "URL";
  /** Overrides the chat color under the paint; absent means keep it. */
  color?: string;
  angle: number;
  shape?: string;
  image_url?: string;
  repeat: boolean;
  stops: PaintStop[];
  shadows: PaintShadow[];
}

export interface UserPaint {
  user_id: string;
  /** null when the user no longer wears a paint. */
  paint_id: string | null;
}

export interface PaintSnapshot {
  paints: Paint[];
  users: UserPaint[];
}

export interface PaintStore {
  addPaint: (paint: Paint) => void;
  assign: (users: UserPaint[]) => void;
  load: (snapshot: PaintSnapshot) => void;
  paintFor: (userId: string) => Paint | undefined;
}

export function createPaintStore(): PaintStore {
  const paints = new Map<string, Paint>();
  const wearing = new Map<string, string>();
  const [revision, setRevision] = createSignal(0);

  function assignAll(users: UserPaint[]): void {
    for (const u of users) {
      if (u.paint_id) wearing.set(u.user_id, u.paint_id);
      else wearing.delete(u.user_id);
    }
  }

  return {
    addPaint(paint) {
      paints.set(paint.id, paint);
      setRevision((r) => r + 1);
    },
    assign(users) {
      assignAll(users);
      setRevision((r) => r + 1);
    },
    // Merged rather than swapped in: an event that landed while the
    // snapshot was on its way is already newer than it.
    load(snapshot) {
      for (const p of snapshot.paints) paints.set(p.id, p);
      assignAll(snapshot.users);
      setRevision((r) => r + 1);
    },
    paintFor(userId) {
      revision();
      const id = wearing.get(userId);
      return id === undefined ? undefined : paints.get(id);
    },
  };
}

const defaultStore = createPaintStore();
export const paintFor = defaultStore.paintFor;

/** The paint to draw on a Twitch user's name, unless paints are off. */
export function shownPaint(userId: string): Paint | undefined {
  return settings().showPaints ? paintFor(userId) : undefined;
}

/** Follows the host's paint events and loads what it already has. */
export async function syncPaints(
  store: PaintStore = defaultStore,
): Promise<() => void> {
  const offs = await Promise.all([
    listen<Paint>("seventv_paint", (e) => store.addPaint(e.payload)),
    listen<UserPaint[]>("seventv_paint_users", (e) => store.assign(e.payload)),
  ]);
  try {
    store.load(await invoke<PaintSnapshot>("current_seventv_paints"));
  } catch (err) {
    // Live events still arrive; only paints sent before mount are missing.
    console.error("failed to load 7tv paints:", err);
  }
  return () => {
    for (const off of offs) off();
  };
}
