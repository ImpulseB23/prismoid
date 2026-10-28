// Public profile data for chatters (account age, avatar, bio), fetched from
// Helix in batches so a busy chat costs one request per hundred new
// people rather than one per message. Lookups are deduped for the session;
// the fetcher is injected for tests.

import { createSignal } from "solid-js";
import { getUsersInfo, type UserInfo } from "../lib/twitchChannel";

export const USER_INFO_BATCH = 100;
export const USER_INFO_DEBOUNCE_MS = 250;
/** Accounts younger than this are flagged in the feed. */
export const NEW_ACCOUNT_DAYS = 7;

export interface UserInfoStore {
  /** Queues ids not yet known; resolves once the batch they ride in lands. */
  ensure: (ids: Iterable<string>) => void;
  /**
   * Like `ensure` but sends at once, for something waiting to show these
   * profiles. Settles when they have landed or failed; never rejects.
   */
  load: (ids: Iterable<string>) => Promise<void>;
  info: (id: string) => UserInfo | undefined;
  /** Bumps whenever new profiles arrive, for memos keyed on it. */
  revision: () => number;
  /** Waits for in-flight lookups; for tests. */
  flush: () => Promise<void>;
}

export function createUserInfoStore(
  fetch: (ids: string[]) => Promise<UserInfo[]> = getUsersInfo,
  schedule: (fn: () => void) => void = (fn) =>
    setTimeout(fn, USER_INFO_DEBOUNCE_MS),
): UserInfoStore {
  const known = new Map<string, UserInfo>();
  const requested = new Set<string>();
  const queue: string[] = [];
  const [revision, setRevision] = createSignal(0);
  let scheduled = false;
  let inflight: Promise<void> = Promise.resolve();
  const pending = new Map<string, Promise<void>>();

  async function send(ids: string[]): Promise<void> {
    try {
      for (const u of await fetch(ids)) known.set(u.id, u);
      setRevision((r) => r + 1);
    } catch (err) {
      // Let a later ensure() try again; a transient Helix failure should
      // not pin these ids as unknown for the whole session.
      for (const id of ids) requested.delete(id);
      console.error("user info", err);
    }
  }

  function drain(): void {
    scheduled = false;
    const batches: Promise<void>[] = [];
    while (queue.length > 0) {
      const ids = queue.splice(0, USER_INFO_BATCH);
      const batch = send(ids).finally(() => {
        for (const id of ids) pending.delete(id);
      });
      for (const id of ids) pending.set(id, batch);
      batches.push(batch);
    }
    if (batches.length > 0) {
      inflight = Promise.all([inflight, ...batches]).then(() => {});
    }
  }

  function ensure(ids: Iterable<string>): void {
    for (const id of ids) {
      if (!id || requested.has(id)) continue;
      requested.add(id);
      queue.push(id);
    }
    if (queue.length > 0 && !scheduled) {
      scheduled = true;
      schedule(drain);
    }
  }

  async function load(ids: Iterable<string>): Promise<void> {
    const list = [...ids];
    ensure(list);
    if (queue.length > 0) drain();
    await Promise.all(list.map((id) => pending.get(id)));
  }

  return {
    ensure,
    load,
    info: (id) => known.get(id),
    revision,
    flush: () => inflight,
  };
}

/** Whole days since the account was created; null when unknown. */
export function accountAgeDays(createdAt: string, now: number): number | null {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function isNewAccount(info: UserInfo | undefined, now: number): boolean {
  if (!info) return false;
  const days = accountAgeDays(info.created_at, now);
  return days !== null && days < NEW_ACCOUNT_DAYS;
}

/** "Joined today", "Joined 3 days ago", "Joined Mar 2019". */
export function formatJoined(createdAt: string, now: number): string {
  const days = accountAgeDays(createdAt, now);
  if (days === null) return "";
  if (days === 0) return "Joined today";
  if (days < 30) return `Joined ${days} ${days === 1 ? "day" : "days"} ago`;
  const date = new Date(createdAt);
  return `Joined ${date.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
}

const defaultStore = createUserInfoStore();
export const ensureUserInfo = defaultStore.ensure;
export const loadUserInfo = defaultStore.load;
export const userInfo = defaultStore.info;
export const userInfoRevision = defaultStore.revision;
