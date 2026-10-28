import { describe, expect, it } from "vitest";
import type { HeldMessage, HeldMessageResolved } from "../lib/chatEvents";
import {
  MAX_HELD_PER_CHANNEL,
  RESOLVED_LINGER_MS,
  createAutomodStore,
} from "./automodStore";

const held = (id: string, channel = "1"): HeldMessage => ({
  kind: "automod_held",
  channel_id: channel,
  message_id: id,
  user_id: "42",
  user_login: "chatter",
  user_name: "Chatter",
  text: `text ${id}`,
  reason: "automod",
  category: "aggressive",
  level: 2,
  held_at: 0,
});

const resolved = (
  id: string,
  status: HeldMessageResolved["status"],
  by = "ModGuy",
): HeldMessageResolved => ({
  kind: "automod_resolved",
  channel_id: "1",
  message_id: id,
  status,
  moderator_login: by.toLowerCase(),
  moderator_name: by,
});

function manualTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => pending.push({ fn, ms }),
    flush: () => pending.splice(0).forEach((t) => t.fn()),
    pending,
  };
}

describe("automodStore", () => {
  it("queues holds per channel newest first and ignores repeats", () => {
    const s = createAutomodStore(manualTimers().schedule);
    s.hold(held("a"));
    s.hold(held("b"));
    s.hold(held("a"));
    s.hold(held("c", "2"));
    expect(s.entries("1").map((e) => e.message.message_id)).toEqual(["b", "a"]);
    expect(s.pendingCount("1")).toBe(2);
    expect(s.pendingCount("2")).toBe(1);
    expect(s.entries("3")).toEqual([]);
  });

  it("shows the outcome, then drops it after the linger", () => {
    const timers = manualTimers();
    const s = createAutomodStore(timers.schedule);
    s.hold(held("a"));
    s.hold(held("b"));
    s.resolve(resolved("a", "denied"));
    const a = s.entries("1").find((e) => e.message.message_id === "a");
    expect(a?.status).toBe("denied");
    expect(a?.by).toBe("ModGuy");
    expect(s.pendingCount("1")).toBe(1);
    expect(timers.pending[0].ms).toBe(RESOLVED_LINGER_MS);
    timers.flush();
    expect(s.entries("1").map((e) => e.message.message_id)).toEqual(["b"]);
  });

  it("lets Twitch name the mod after a local resolve without a second timer", () => {
    const timers = manualTimers();
    const s = createAutomodStore(timers.schedule);
    s.hold(held("a"));
    s.resolve({ ...resolved("a", "approved"), moderator_name: "" });
    s.resolve(resolved("a", "approved", "Me"));
    expect(s.entries("1")[0].by).toBe("Me");
    expect(timers.pending).toHaveLength(1);
  });

  it("ignores updates for messages it never saw", () => {
    const timers = manualTimers();
    const s = createAutomodStore(timers.schedule);
    s.resolve(resolved("ghost", "expired"));
    expect(s.entries("1")).toEqual([]);
    expect(timers.pending).toHaveLength(0);
  });

  it("caps each channel and survives a clear with timers in flight", () => {
    const timers = manualTimers();
    const s = createAutomodStore(timers.schedule);
    for (let i = 0; i <= MAX_HELD_PER_CHANNEL; i++) s.hold(held(`m${i}`));
    expect(s.entries("1")).toHaveLength(MAX_HELD_PER_CHANNEL);
    s.resolve(resolved(`m${MAX_HELD_PER_CHANNEL}`, "expired"));
    s.clear();
    s.hold(held(`m${MAX_HELD_PER_CHANNEL}`));
    timers.flush();
    expect(s.pendingCount("1")).toBe(1);
  });
});
