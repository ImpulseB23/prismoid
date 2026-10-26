import { describe, expect, it } from "vitest";
import type { ModAction } from "./chatEvents";
import {
  describeModAction,
  describePublicModeration,
  modActionMessage,
  publicModerationMessage,
} from "./modActions";

const base: ModAction = {
  kind: "mod_action",
  channel_id: "1",
  timestamp: 1_700_000_000_000,
  moderator_login: "modguy",
  moderator_name: "ModGuy",
  action: "timeout",
  target_user_id: "42",
  target_user_login: "spammer",
  target_user_name: "Spammer",
  reason: "",
  duration_seconds: null,
  message_id: "",
  message_body: "",
  wait_time_seconds: null,
  follow_duration_minutes: null,
  viewer_count: null,
  terms: [],
  moderator_message: "",
};

describe("describePublicModeration", () => {
  it("states the effect without a moderator", () => {
    expect(
      describePublicModeration({
        kind: "user_cleared",
        channel_id: "c",
        target_user_id: "1",
        target_user_login: "bob",
        target_user_name: "Bob",
      }),
    ).toBe("Bob was timed out or banned");
    expect(
      describePublicModeration(
        {
          kind: "message_deleted",
          channel_id: "c",
          message_id: "m",
          target_user_id: "",
        },
        { display_name: "Bob", message_text: "spam" },
      ),
    ).toBe("A message from Bob was deleted: spam");
    expect(
      describePublicModeration({
        kind: "message_deleted",
        channel_id: "c",
        message_id: "m",
        target_user_id: "",
      }),
    ).toBe("A message was deleted");
    expect(
      describePublicModeration({ kind: "chat_cleared", channel_id: "c" }),
    ).toBe("Chat was cleared");
  });

  it("builds a notice row carrying the target", () => {
    const row = publicModerationMessage(
      {
        kind: "user_cleared",
        channel_id: "c",
        target_user_id: "1",
        target_user_login: "bob",
        target_user_name: "Bob",
      },
      7,
    );
    expect(row.notice?.notice_type).toBe("mod_action");
    expect(row.username).toBe("bob");
    expect(row.platform_user_id).toBe("1");
    expect(row.channel_id).toBe("c");
    expect(row.arrival_seq).toBe(7);
  });
});

describe("describeModAction", () => {
  it("names the moderator, the target, the length and the reason", () => {
    expect(
      describeModAction({ ...base, duration_seconds: 600, reason: "caps" }),
    ).toBe("ModGuy timed out Spammer for 10m: caps");
    expect(describeModAction({ ...base, action: "ban" })).toBe(
      "ModGuy banned Spammer",
    );
    expect(
      describeModAction({ ...base, action: "delete", message_body: "hi" }),
    ).toBe("ModGuy deleted a message from Spammer: hi");
  });

  it("describes room settings and terms", () => {
    expect(
      describeModAction({ ...base, action: "slow", wait_time_seconds: 30 }),
    ).toBe("ModGuy turned on slow mode (30s)");
    expect(
      describeModAction({
        ...base,
        action: "followers",
        follow_duration_minutes: 90,
      }),
    ).toBe("ModGuy turned on followers-only (1h 30m)");
    expect(
      describeModAction({ ...base, action: "add_blocked_term", terms: ["x"] }),
    ).toBe('ModGuy blocked "x"');
    expect(describeModAction({ ...base, action: "something_new" })).toBe(
      "ModGuy performed something new",
    );
  });

  it("builds a notice row tied to the target user", () => {
    const row = modActionMessage({ ...base, action: "ban" }, 7);
    expect(row.notice?.notice_type).toBe("mod_action");
    expect(row.platform_user_id).toBe("42");
    expect(row.arrival_seq).toBe(7);
    expect(row.message_text).toBe("");
  });
});
