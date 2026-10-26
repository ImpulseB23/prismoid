import { describe, expect, it } from "vitest";
import type { ModAction } from "../lib/chatEvents";
import { MAX_ACTIONS_PER_USER, createModLogStore } from "./modLogStore";

const action = (target: string, verb: string, t = 0): ModAction => ({
  kind: "mod_action",
  channel_id: "1",
  timestamp: t,
  moderator_login: "m",
  moderator_name: "M",
  action: verb,
  target_user_id: target,
  target_user_login: `u${target}`,
  target_user_name: `U${target}`,
  reason: "",
  duration_seconds: null,
  message_id: "",
  message_body: "",
  wait_time_seconds: null,
  follow_duration_minutes: null,
  viewer_count: null,
  terms: [],
  moderator_message: "",
});

describe("modLogStore", () => {
  it("keeps per-user history newest first and ignores room-wide actions", () => {
    const s = createModLogStore();
    s.record(action("42", "timeout", 1));
    s.record(action("42", "ban", 2));
    s.record(action("", "slow", 3));
    expect(s.forUser("42").map((a) => a.action)).toEqual(["ban", "timeout"]);
    expect(s.forUser("9")).toEqual([]);
  });

  it("caps history per user and clears", () => {
    const s = createModLogStore();
    for (let i = 0; i < MAX_ACTIONS_PER_USER + 5; i++) {
      s.record(action("1", "timeout", i));
    }
    expect(s.forUser("1")).toHaveLength(MAX_ACTIONS_PER_USER);
    expect(s.forUser("1")[0]!.timestamp).toBe(MAX_ACTIONS_PER_USER + 4);
    s.clear();
    expect(s.forUser("1")).toEqual([]);
  });
});
