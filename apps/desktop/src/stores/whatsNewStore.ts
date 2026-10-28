// Tells the user when an update has installed itself. The version that last
// ran is remembered; launching a different one raises a flag that lights
// the Settings icon until Settings is opened, where a link to the release
// notes stays for the rest of the session.

import { createSignal } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import type { StorageLike } from "./channelStore";

const KEY = "prismoid.lastVersion";
export const RELEASES_URL = "https://github.com/ImpulseB23/Prismoid/releases";

export interface WhatsNewStore {
  /** The version installed by the last update, while it is news. */
  updatedTo: () => string | null;
  /** True until Settings has been opened after an update. */
  unseen: () => boolean;
  /** Compares the running version with the one that ran last. */
  init: () => Promise<void>;
  markSeen: () => void;
}

export function createWhatsNewStore(
  storage: StorageLike | null = defaultStorage(),
  version: () => Promise<string> = getVersion,
): WhatsNewStore {
  const [updatedTo, setUpdatedTo] = createSignal<string | null>(null);
  const [unseen, setUnseen] = createSignal(false);

  async function init(): Promise<void> {
    const current = await version();
    const last = read(storage);
    // A first install has nothing to announce.
    if (last !== null && last !== current) {
      setUpdatedTo(current);
      setUnseen(true);
    }
    write(storage, current);
  }

  return {
    updatedTo,
    unseen,
    init,
    markSeen: () => setUnseen(false),
  };
}

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

function read(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, value: string): void {
  try {
    storage?.setItem(KEY, value);
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
