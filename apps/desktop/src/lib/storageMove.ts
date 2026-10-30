// The webview side of src-tauri/src/storage_move.rs: localStorage moving
// from the old http origin to the https one the windows use now.

import { invoke } from "@tauri-apps/api/core";

/** The hidden window the host opens on the old origin. */
export const STORAGE_MOVE_LABEL = "storage-move";

type Entries = [string, string][];

/** Hidden window: hand everything over, then clear it once it is kept. */
export async function exportOldStorage(storage: Storage): Promise<void> {
  const entries: Entries = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    entries.push([key, storage.getItem(key)!]);
  }
  const kept = await invoke<boolean>("storage_move_export", { entries });
  if (kept) storage.clear();
  await invoke("storage_move_finish", { cleared: kept });
}

/**
 * Main window, before anything reads storage. A key already set here wins:
 * after a move that gave up and was retried on a later launch, it holds
 * what the user changed in between.
 */
export async function importOldStorage(storage: Storage): Promise<void> {
  const entries = await invoke<Entries | null>("storage_move_import");
  if (!entries) return;
  for (const [key, value] of entries) {
    if (storage.getItem(key) === null) storage.setItem(key, value);
  }
  await invoke("storage_move_imported");
}
