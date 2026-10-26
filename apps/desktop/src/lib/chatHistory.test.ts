import { describe, expect, it, vi } from "vitest";
import { createHistoryGate } from "./chatHistory";
import type { ChatMessage } from "../stores/chatStore";

function msg(id: string): ChatMessage {
  return {
    id,
    platform: "Twitch",
    timestamp: 0,
    arrival_time: 0,
    effective_ts: 0,
    arrival_seq: 0,
    username: "u",
    display_name: "U",
    platform_user_id: "1",
    channel_id: "c",
    message_text: id,
    badges: [],
    is_mod: false,
    is_subscriber: false,
    is_broadcaster: false,
    color: null,
    reply_to: null,
    reply_parent: null,
    notice: null,
    emote_spans: [],
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createHistoryGate", () => {
  it("passes batches through when no load is in flight", () => {
    const added: ChatMessage[][] = [];
    const gate = createHistoryGate((b) => added.push(b));
    expect(gate.offer([msg("a")])).toBe(false);
    expect(added).toEqual([]);
  });

  it("holds live batches until history lands, then dedupes by id", async () => {
    const added: string[][] = [];
    const gate = createHistoryGate((b) => added.push(b.map((m) => m.id)));
    const load = deferred<ChatMessage[]>();
    gate.begin(load.promise);
    expect(gate.offer([msg("c"), msg("d")])).toBe(true);
    load.resolve([msg("a"), msg("b"), msg("c")]);
    await flush();
    expect(added).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(gate.offer([msg("e")])).toBe(false);
  });

  it("drops a load that resolves after the channel changed", async () => {
    const added: string[][] = [];
    const gate = createHistoryGate((b) => added.push(b.map((m) => m.id)));
    const first = deferred<ChatMessage[]>();
    const second = deferred<ChatMessage[]>();
    gate.begin(first.promise);
    gate.offer([msg("stale")]);
    gate.begin(second.promise);
    gate.offer([msg("live")]);
    first.resolve([msg("old")]);
    second.resolve([msg("new")]);
    await flush();
    expect(added).toEqual([["new"], ["live"]]);
  });

  it("releases the queue when the load fails", async () => {
    const added: string[][] = [];
    const gate = createHistoryGate((b) => added.push(b.map((m) => m.id)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred<ChatMessage[]>();
    gate.begin(load.promise);
    gate.offer([msg("x")]);
    load.reject(new Error("db gone"));
    await flush();
    expect(added).toEqual([[], ["x"]]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("cancel lets live batches through and ignores the late load", async () => {
    const added: string[][] = [];
    const gate = createHistoryGate((b) => added.push(b.map((m) => m.id)));
    const load = deferred<ChatMessage[]>();
    gate.begin(load.promise);
    gate.cancel();
    expect(gate.offer([msg("a")])).toBe(false);
    load.resolve([msg("old")]);
    await flush();
    expect(added).toEqual([]);
  });
});
