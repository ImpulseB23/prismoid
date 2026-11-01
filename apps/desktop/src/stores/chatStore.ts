// ADR 21 + docs/frontend.md: plain TS ring buffer outside Solid reactivity,
// one viewport signal per frame. The virtual scroller reads messages from
// the ring by monotonic index.

import { createSignal } from "solid-js";

export interface EmoteMeta {
  id: string;
  code: string;
  provider: "twitch" | "7tv" | "bttv" | "ffz";
  url_1x: string;
  url_2x: string;
  url_4x: string;
  width: number;
  height: number;
  animated: boolean;
  /** Still frames of an animated emote, for when animation is off. */
  static_1x?: string;
  static_2x?: string;
  zero_width: boolean;
  /**
   * Uploader, when the provider reports one (7TV, FFZ, BTTV shared emotes).
   * `id` is the account id on that provider, not a Twitch id.
   */
  owner?: { id?: string; login?: string; display_name: string };
  /** Unix ms the emote was added to the channel's set. 7TV channel emotes only. */
  added_at?: number;
  /**
   * 7TV user id of whoever added the emote to the channel's set. Resolve the
   * name with `getSevenTvUsers`.
   */
  added_by_id?: string;
}

/**
 * One scanned emote occurrence inside `ChatMessage.message_text`.
 *
 * `start` and `end` are **UTF-8 byte offsets** as produced by the Rust
 * scanner, not UTF-16 code-unit offsets. JavaScript string indexing
 * (`String.prototype.slice`, `[]`, etc.) operates on UTF-16, so renderers
 * that splice the message around emote spans must translate first. The
 * straightforward way is to encode `message_text` once with `TextEncoder`
 * and slice the resulting `Uint8Array`, decoding each segment with
 * `TextDecoder`. For ASCII-only messages the two are equivalent.
 */
export interface EmoteSpan {
  start: number;
  end: number;
  emote: EmoteMeta;
}

export interface ChatMessage {
  id: string;
  platform: "Twitch" | "YouTube" | "Kick";
  timestamp: number;
  arrival_time: number;
  /**
   * Sort timestamp under the unified-ordering snap rule (see
   * `message.rs::compute_effective_ts`). Equals `timestamp` when the
   * platform clock agrees with local arrival within the snap window,
   * otherwise equals `arrival_time`. Use `(effective_ts, arrival_seq)`
   * as a stable sort key when interleaving messages from different
   * platforms or repositioning late arrivals.
   */
  effective_ts: number;
  /**
   * Per-process monotonic arrival counter assigned by the Rust drain
   * loop. Tie-breaks messages with identical `effective_ts` so two
   * renderers always agree on order.
   */
  arrival_seq: number;
  username: string;
  display_name: string;
  platform_user_id: string;
  /**
   * Room the message was posted in (Twitch broadcaster id, YouTube live
   * chat id, Kick chatroom id). Renderers drop Twitch messages whose
   * `channel_id` is not the active channel so stragglers from a channel
   * switch never land in the new view.
   */
  channel_id: string;
  message_text: string;
  /** `info` is Twitch's detail, the months subscribed on a sub badge. */
  badges: { set_id: string; id: string; info?: string }[];
  is_mod: boolean;
  is_subscriber: boolean;
  is_broadcaster: boolean;
  color: string | null;
  reply_to: string | null;
  /** Who and what a reply answers; null for top-level messages. */
  reply_parent: {
    user_login: string;
    user_name: string;
    body: string;
    /** The message that started the thread; empty when the platform did not say. */
    thread_id: string;
  } | null;
  /** Twitch system notice (sub, raid, announcement) this row represents. */
  notice: { notice_type: string; system_message: string } | null;
  emote_spans: EmoteSpan[];
  /**
   * Optimistic-render state. `undefined` for confirmed messages (the
   * common case). `"pending"` while waiting for the platform echo,
   * `"failed"` when send was rejected. The renderer uses this to dim
   * pending entries and surface failed ones with a retry affordance.
   */
  status?: "pending" | "failed";
  /** Removed by a moderator after it was shown. Kept in place, rendered dimmed. */
  deleted?: boolean;
  /** Twitch flagged it as the chatter's first in the channel; set on rows loaded from history. */
  first_message?: boolean;
  /**
   * Client-generated id used to correlate an optimistic message with
   * its later platform echo. Only set on optimistic inserts.
   */
  local_id?: string;
  /** Human-readable failure reason; only set when status is "failed". */
  error_message?: string;
}

export interface Viewport {
  /** Monotonic index of the oldest message currently in the ring. */
  start: number;
  /** Number of valid messages in the ring (≤ maxMessages). */
  count: number;
}

/**
 * Window for matching an authoritative platform echo to a still-pending
 * optimistic message by fingerprint (platform + author + message text).
 * Generous enough to absorb sidecar cold-start latency without letting
 * genuine duplicates collapse onto stale pending entries.
 */
export const PENDING_FINGERPRINT_WINDOW_MS = 30_000;

/**
 * How many recent messages to scan when reconciling an incoming batch
 * against pending entries. Bounds the reconcile cost regardless of
 * pending-set size.
 */
export const PENDING_SCAN_TAIL = 64;

export interface ChatStore {
  viewport: () => Viewport;
  /**
   * Increments when messages already in the ring change (reconcile, fail,
   * retry, deletion). A change replaces the message with a new object
   * rather than editing it, so a renderer caching per-message work can
   * redo just the entries whose object differs from the one it cached.
   * Pure appends bump the viewport signal instead.
   */
  messageRevision: () => number;
  addMessages: (batch: ChatMessage[]) => void;
  getMessage: (monoIndex: number) => ChatMessage | undefined;
  /** Newest live message with this platform id, if it is still in the ring. */
  findById: (id: string) => ChatMessage | undefined;
  /** Ring index of a confirmed message, if it is still loaded. */
  monoOf: (id: string) => number | undefined;
  /**
   * Inserts a locally-authored message in pending state. The caller
   * supplies a `local_id`; later calls to `confirmPendingId`,
   * `failPending`, and `retryPending` use it to find the entry. The
   * message renders immediately and is reconciled in place when its
   * authoritative platform echo arrives.
   */
  insertPending: (msg: ChatMessage) => void;
  /**
   * Records the Helix-assigned message id for a pending entry so a
   * subsequent echo can be matched by id (faster, more precise than
   * the fingerprint fallback). No-op if the entry has already been
   * reconciled or evicted.
   */
  confirmPendingId: (localId: string, messageId: string) => void;
  /**
   * Marks a pending entry as failed and stamps a human-readable
   * error. The message stays in the ring so the user can see what
   * went wrong and retry. No-op if already reconciled or evicted.
   */
  failPending: (localId: string, errorMessage: string) => void;
  /**
   * Resets a failed entry to pending state and returns its message
   * text so the caller can re-invoke the send command. Returns
   * `undefined` if the entry is missing or not in failed state.
   */
  retryPending: (localId: string) => string | undefined;
  /**
   * Drops every message from view (channel switch). Monotonic indices
   * keep increasing so renderer caches keyed by index stay valid.
   */
  clear: () => void;
  /**
   * Confirmed messages by one author still held in the ring, oldest
   * first, at most `limit`. Scans from the newest end so cost is bounded
   * by the ring size, not the session length.
   */
  recentByUser: (platformUserId: string, limit: number) => ChatMessage[];
  /** Confirmed messages that pass `match`, newest first, up to `limit`. */
  search: (
    match: (msg: ChatMessage) => boolean,
    limit: number,
  ) => ChatMessage[];
  /** Marks one message deleted by id. No-op if it is not in the ring. */
  markDeleted: (messageId: string) => void;
  /** Marks every message by one author deleted (ban or timeout). */
  markUserCleared: (platformUserId: string) => void;
  /** Marks everything deleted (chat clear). */
  markAllDeleted: () => void;
  /** Swaps a confirmed message for `change(it)`. No-op if it is gone. */
  update: (id: string, change: (msg: ChatMessage) => ChatMessage) => void;
}

export const DEFAULT_MAX_MESSAGES = 5000;

/**
 * Frontend-only seq sentinel for optimistic pending messages. Set well
 * above any plausible per-session backend `arrival_seq` (which starts
 * at 0 and increments once per emitted message) so that when a future
 * sort layer compares `(effective_ts, arrival_seq)` across the ring,
 * pending entries naturally sort to the tail. Each pending insert
 * increments the local counter from the same high base so multiple
 * concurrent pending messages still preserve submit order.
 */
const OPTIMISTIC_SEQ_BASE = Number.MAX_SAFE_INTEGER - 1_000_000;
let nextOptimisticSeq = OPTIMISTIC_SEQ_BASE;

export interface OptimisticInput {
  platform: ChatMessage["platform"];
  /** Login of the signed-in user; used as both username and provisional
   * display name on the optimistic entry. */
  login: string;
  /** Trimmed payload, exactly as it will be sent to the platform. */
  text: string;
  /** Active channel the message is being sent to. */
  channelId: string;
  /**
   * How the user looks in this channel, so the message shows the same way
   * while it is sent as once Twitch echoes it back. Missing parts fall back
   * to the login, no color and no badges.
   */
  look?: {
    userId: string;
    displayName?: string;
    color: string | null;
    badges?: ChatMessage["badges"];
    emoteSpans?: EmoteSpan[];
  };
}

/**
 * Builds a `ChatMessage` in pending state from the user's locally-known
 * identity. The `local_id` is generated here so the caller can hand it
 * straight to `confirmPendingId` / `failPending` after invoking the
 * send command. Stamps `effective_ts` with the local clock so the
 * snap rule keeps the message at "now" until reconciliation.
 */
export function buildOptimisticMessage(input: OptimisticInput): ChatMessage {
  const now = Date.now();
  const localId = generateLocalId();
  return {
    id: localId,
    platform: input.platform,
    timestamp: now,
    arrival_time: now,
    effective_ts: now,
    arrival_seq: nextOptimisticSeq++,
    username: input.login,
    display_name: input.look?.displayName ?? input.login,
    platform_user_id: input.look?.userId ?? "",
    channel_id: input.channelId,
    message_text: input.text,
    badges: input.look?.badges ?? [],
    is_mod: false,
    is_subscriber: false,
    is_broadcaster: false,
    color: input.look?.color ?? null,
    reply_to: null,
    reply_parent: null,
    notice: null,
    emote_spans: input.look?.emoteSpans ?? [],
    status: "pending",
    local_id: localId,
  };
}

function generateLocalId(): string {
  const c =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback for environments without WebCrypto. Not security-sensitive
  // here — only needs to be unique within the per-process pending set.
  return `local-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Creates a chat store backed by a plain pre-allocated ring buffer. Writes
 * happen synchronously; the single viewport signal is batched into one
 * `requestAnimationFrame` tick so multiple batches arriving within the same
 * frame coalesce into exactly one reactive update.
 */
export function createChatStore(maxMessages = DEFAULT_MAX_MESSAGES): ChatStore {
  if (maxMessages <= 0) {
    throw new Error(`maxMessages must be positive, got ${maxMessages}`);
  }

  // Pre-allocated ring. Undefined slots only exist before writeIndex reaches
  // maxMessages for the first time; getMessage guards against reading them.
  const ring: (ChatMessage | undefined)[] = new Array<ChatMessage | undefined>(
    maxMessages,
  );
  let writeIndex = 0;
  // Oldest index still visible. Bumped to `writeIndex` on clear(), so
  // everything written before the clear reads as evicted.
  let floor = 0;
  let rafPending = false;
  let pendingMutation = false;

  // localId → monoIndex of the pending entry. Stays in the map until
  // the entry is reconciled or evicted from the ring; we lazily prune
  // stale map entries when we discover an evicted monoIndex on access.
  const pendingByLocalId = new Map<string, number>();

  const [viewport, setViewport] = createSignal<Viewport>({
    start: 0,
    count: 0,
  });
  const [messageRevision, setMessageRevision] = createSignal(0);

  function oldestLive(): number {
    return Math.max(floor, writeIndex - maxMessages);
  }

  function isLive(monoIndex: number): boolean {
    return monoIndex >= oldestLive();
  }

  function lookupPendingEntry(
    localId: string,
  ): { monoIndex: number; msg: ChatMessage } | undefined {
    const monoIndex = pendingByLocalId.get(localId);
    if (monoIndex === undefined) return undefined;
    if (!isLive(monoIndex)) {
      pendingByLocalId.delete(localId);
      return undefined;
    }
    const msg = ring[monoIndex % maxMessages];
    if (!msg || msg.local_id !== localId) {
      pendingByLocalId.delete(localId);
      return undefined;
    }
    return { monoIndex, msg };
  }

  // Messages in the ring are never edited: a change puts a new object in
  // the slot, which is how renderers spot exactly what changed.
  function replace(monoIndex: number, next: ChatMessage): void {
    ring[monoIndex % maxMessages] = next;
  }

  function tryReconcile(incoming: ChatMessage): boolean {
    if (pendingByLocalId.size === 0) return false;
    const tailStart = Math.max(oldestLive(), writeIndex - PENDING_SCAN_TAIL);
    for (let mono = writeIndex - 1; mono >= tailStart; mono--) {
      const entry = ring[mono % maxMessages];
      // Reconcile against both pending and failed optimistic entries:
      // a transport error followed by the platform echo arriving anyway
      // (e.g. ambiguous timeout, retried by us elsewhere) should heal
      // the failed entry instead of leaving it red beside a duplicate.
      if (!entry || (entry.status !== "pending" && entry.status !== "failed"))
        continue;
      if (entry.platform !== incoming.platform) continue;
      const idMatch = entry.id === incoming.id && entry.id.length > 0;
      const fingerprintMatch =
        entry.username === incoming.username &&
        entry.message_text === incoming.message_text &&
        Math.abs(incoming.arrival_time - entry.arrival_time) <
          PENDING_FINGERPRINT_WINDOW_MS;
      if (!idMatch && !fingerprintMatch) continue;
      const localId = entry.local_id;
      replace(mono, reconciled(entry, incoming));
      if (localId) pendingByLocalId.delete(localId);
      return true;
    }
    return false;
  }

  function reconciled(entry: ChatMessage, incoming: ChatMessage): ChatMessage {
    // Adopt authoritative identity and rendering data, but keep the
    // optimistic position (arrival_seq) so the row doesn't jump. The
    // entry is no longer optimistic after this, so drop status,
    // local_id, and any prior error string.
    return {
      ...entry,
      id: incoming.id,
      timestamp: incoming.timestamp,
      arrival_time: incoming.arrival_time,
      effective_ts: incoming.effective_ts,
      username: incoming.username,
      display_name: incoming.display_name,
      platform_user_id: incoming.platform_user_id,
      message_text: incoming.message_text,
      badges: incoming.badges,
      is_mod: incoming.is_mod,
      is_subscriber: incoming.is_subscriber,
      is_broadcaster: incoming.is_broadcaster,
      color: incoming.color,
      reply_to: incoming.reply_to,
      reply_parent: incoming.reply_parent,
      notice: incoming.notice,
      emote_spans: incoming.emote_spans,
      status: undefined,
      error_message: undefined,
      local_id: undefined,
    };
  }

  function addMessages(batch: ChatMessage[]): void {
    if (batch.length === 0) return;
    let appended = 0;
    let mutated = false;
    for (const msg of batch) {
      if (tryReconcile(msg)) {
        mutated = true;
        continue;
      }
      ring[writeIndex % maxMessages] = msg;
      writeIndex++;
      appended++;
    }
    if (appended > 0) scheduleViewportUpdate();
    if (mutated) bumpMessageRevision();
  }

  function insertPending(msg: ChatMessage): void {
    if (!msg.local_id) {
      throw new Error("insertPending requires msg.local_id");
    }
    ring[writeIndex % maxMessages] = { ...msg, status: "pending" };
    pendingByLocalId.set(msg.local_id, writeIndex);
    writeIndex++;
    scheduleViewportUpdate();
  }

  function confirmPendingId(localId: string, messageId: string): void {
    const found = lookupPendingEntry(localId);
    if (!found || messageId.length === 0) return;
    replace(found.monoIndex, { ...found.msg, id: messageId });
    // No revision bump: the id is invisible to renderers and the entry is
    // still pending. The reconcile-by-id path picks it up when the echo
    // arrives.
  }

  function failPending(localId: string, errorMessage: string): void {
    const found = lookupPendingEntry(localId);
    if (!found) return;
    replace(found.monoIndex, {
      ...found.msg,
      status: "failed",
      error_message: errorMessage,
    });
    bumpMessageRevision();
  }

  function retryPending(localId: string): string | undefined {
    const found = lookupPendingEntry(localId);
    if (!found || found.msg.status !== "failed") return undefined;
    replace(found.monoIndex, {
      ...found.msg,
      status: "pending",
      error_message: undefined,
    });
    bumpMessageRevision();
    return found.msg.message_text;
  }

  function scheduleViewportUpdate(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      setViewport(currentViewport());
    });
  }

  function currentViewport(): Viewport {
    const start = oldestLive();
    return { start, count: writeIndex - start };
  }

  function clear(): void {
    floor = writeIndex;
    pendingByLocalId.clear();
    setViewport(currentViewport());
  }

  function bumpMessageRevision(): void {
    if (pendingMutation) return;
    pendingMutation = true;
    requestAnimationFrame(() => {
      pendingMutation = false;
      setMessageRevision((n) => n + 1);
    });
  }

  function getMessage(monoIndex: number): ChatMessage | undefined {
    if (monoIndex >= writeIndex || !isLive(monoIndex)) return undefined;
    return ring[monoIndex % maxMessages];
  }

  function recentByUser(platformUserId: string, limit: number): ChatMessage[] {
    const out: ChatMessage[] = [];
    const stop = oldestLive();
    for (
      let mono = writeIndex - 1;
      mono >= stop && out.length < limit;
      mono--
    ) {
      const msg = ring[mono % maxMessages];
      if (!msg || msg.status !== undefined) continue;
      if (msg.platform_user_id === platformUserId) out.push(msg);
    }
    return out.reverse();
  }

  function search(
    match: (msg: ChatMessage) => boolean,
    limit: number,
  ): ChatMessage[] {
    const out: ChatMessage[] = [];
    const stop = oldestLive();
    for (
      let mono = writeIndex - 1;
      mono >= stop && out.length < limit;
      mono--
    ) {
      const msg = ring[mono % maxMessages];
      if (msg && msg.status === undefined && match(msg)) out.push(msg);
    }
    return out;
  }

  function findById(id: string): ChatMessage | undefined {
    const stop = oldestLive();
    for (let mono = writeIndex - 1; mono >= stop; mono--) {
      const msg = ring[mono % maxMessages];
      if (msg && msg.id === id && msg.status === undefined) return msg;
    }
    return undefined;
  }

  function monoOf(id: string): number | undefined {
    const stop = oldestLive();
    for (let mono = writeIndex - 1; mono >= stop; mono--) {
      const msg = ring[mono % maxMessages];
      if (msg && msg.id === id && msg.status === undefined) return mono;
    }
    return undefined;
  }

  function markWhere(pred: (msg: ChatMessage) => boolean): void {
    let changed = false;
    const stop = oldestLive();
    for (let mono = writeIndex - 1; mono >= stop; mono--) {
      const msg = ring[mono % maxMessages];
      if (!msg || msg.deleted || msg.status !== undefined) continue;
      if (pred(msg)) {
        replace(mono, { ...msg, deleted: true });
        changed = true;
      }
    }
    if (changed) bumpMessageRevision();
  }

  function markDeleted(messageId: string): void {
    markWhere((m) => m.id === messageId);
  }

  function markUserCleared(platformUserId: string): void {
    markWhere((m) => m.platform_user_id === platformUserId);
  }

  function markAllDeleted(): void {
    markWhere(() => true);
  }

  function update(id: string, change: (msg: ChatMessage) => ChatMessage): void {
    const mono = monoOf(id);
    if (mono === undefined) return;
    replace(mono, change(ring[mono % maxMessages]!));
    bumpMessageRevision();
  }

  return {
    viewport,
    messageRevision,
    addMessages,
    getMessage,
    findById,
    monoOf,
    insertPending,
    confirmPendingId,
    failPending,
    retryPending,
    clear,
    recentByUser,
    search,
    markDeleted,
    markUserCleared,
    markAllDeleted,
    update,
  };
}
