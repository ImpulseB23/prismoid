// Tells the user when an update has installed itself. The version that last
// ran is remembered; launching a different one opens that version's patch
// notes, or lights the Settings icon when a release has none written.

import { createSignal } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import type { StorageLike } from "./channelStore";
import { notesSince, type ReleaseNote } from "../releaseNotes";

export const LAST_VERSION_KEY = "prismoid.lastVersion";
export const RELEASES_URL = "https://github.com/ImpulseB23/Prismoid/releases";

export interface WhatsNewStore {
  /** The version installed by the last update, while it is news. */
  updatedTo: () => string | null;
  /** True until Settings has been opened after an update. */
  unseen: () => boolean;
  /** Compares the running version with the one that ran last. */
  init: () => Promise<void>;
  markSeen: () => void;
  /** Patch notes on screen, if any. */
  notes: () => ReleaseNote | null;
  showNotes: (note: ReleaseNote) => void;
  closeNotes: () => void;
}

export function createWhatsNewStore(
  storage: StorageLike | null = defaultStorage(),
  version: () => Promise<string> = getVersion,
  lookup: (from: string, to: string) => ReleaseNote | undefined = notesSince,
): WhatsNewStore {
  const [updatedTo, setUpdatedTo] = createSignal<string | null>(null);
  const [unseen, setUnseen] = createSignal(false);
  const [notes, setNotes] = createSignal<ReleaseNote | null>(null);

  async function init(): Promise<void> {
    const current = await version();
    const last = read(storage);
    // A first install has nothing to announce.
    if (last !== null && last !== current) {
      setUpdatedTo(current);
      const note = lookup(last, current);
      if (note) setNotes(note);
      else setUnseen(true);
    }
    write(storage, current);
  }

  return {
    updatedTo,
    unseen,
    init,
    markSeen: () => setUnseen(false),
    notes,
    showNotes: setNotes,
    closeNotes: () => setNotes(null),
  };
}

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

function read(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(LAST_VERSION_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, value: string): void {
  try {
    storage?.setItem(LAST_VERSION_KEY, value);
  } catch {
    // best-effort persistence
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const defaultStore = createWhatsNewStore();
export const updatedTo = defaultStore.updatedTo;
export const whatsNewUnseen = defaultStore.unseen;
export const initWhatsNew = defaultStore.init;
export const markWhatsNewSeen = defaultStore.markSeen;
export const patchNotes = defaultStore.notes;
export const showPatchNotes = defaultStore.showNotes;
export const closePatchNotes = defaultStore.closeNotes;
