// 7TV account names by id. Mirrors apps/desktop/src-tauri/src/seventv_users.rs.

import { invoke } from "@tauri-apps/api/core";

export interface SevenTvUser {
  id: string;
  login: string;
  display_name: string;
}

export type SevenTvError =
  | { kind: "http"; message: string }
  | { kind: "api"; status: number; message: string }
  | { kind: "gql"; message: string };

/**
 * Users for the given 7TV ids, in no particular order; ids 7TV does not know
 * are left out. The host caches found users for the session.
 */
export function getSevenTvUsers(ids: string[]): Promise<SevenTvUser[]> {
  return invoke("seventv_users", { ids });
}
