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

describe("describeModAction covers every action Twitch sends", () => {
  const plain: [string, string][] = [
    ["untimeout", "ModGuy lifted the timeout on Spammer"],
    ["shared_chat_untimeout", "ModGuy lifted the timeout on Spammer"],
    ["unban", "ModGuy unbanned Spammer"],
    ["shared_chat_unban", "ModGuy unbanned Spammer"],
    ["clear", "ModGuy cleared chat"],
    ["slowoff", "ModGuy turned off slow mode"],
    ["followersoff", "ModGuy turned off followers-only"],
    ["emoteonly", "ModGuy turned on emote-only"],
    ["emoteonlyoff", "ModGuy turned off emote-only"],
    ["subscribers", "ModGuy turned on subscribers-only"],
    ["subscribersoff", "ModGuy turned off subscribers-only"],
    ["uniquechat", "ModGuy turned on unique-chat"],
    ["uniquechatoff", "ModGuy turned off unique-chat"],
    ["unraid", "ModGuy cancelled the raid"],
    ["mod", "ModGuy made Spammer a moderator"],
    ["unmod", "ModGuy removed Spammer as moderator"],
    ["vip", "ModGuy made Spammer a VIP"],
    ["unvip", "ModGuy removed Spammer as VIP"],
  ];

  it.each(plain)("%s", (action, text) => {
    expect(describeModAction({ ...base, action })).toBe(text);
  });

  it("describes timeouts, bans and deletes without their optional parts", () => {
    expect(describeModAction(base)).toBe("ModGuy timed out Spammer");
    expect(
      describeModAction({
        ...base,
        action: "shared_chat_timeout",
        duration_seconds: 60,
      }),
    ).toBe("ModGuy timed out Spammer for 1m");
    expect(
      describeModAction({ ...base, action: "shared_chat_ban", reason: "r" }),
    ).toBe("ModGuy banned Spammer: r");
    expect(describeModAction({ ...base, action: "delete" })).toBe(
      "ModGuy deleted a message from Spammer",
    );
    expect(describeModAction({ ...base, action: "shared_chat_delete" })).toBe(
      "ModGuy deleted a message from Spammer",
    );
    expect(
      describeModAction({ ...base, action: "warn", reason: "be nice" }),
    ).toBe("ModGuy warned Spammer: be nice");
  });

  it("describes modes without a value and raids with and without viewers", () => {
    expect(describeModAction({ ...base, action: "slow" })).toBe(
      "ModGuy turned on slow mode",
    );
    expect(describeModAction({ ...base, action: "followers" })).toBe(
      "ModGuy turned on followers-only",
    );
    expect(
      describeModAction({ ...base, action: "raid", viewer_count: 1200 }),
    ).toBe("ModGuy started a raid to Spammer with 1.2K viewers");
    expect(describeModAction({ ...base, action: "raid" })).toBe(
      "ModGuy started a raid to Spammer",
    );
  });

  it("describes term lists and unban requests", () => {
    expect(
      describeModAction({
        ...base,
        action: "remove_blocked_term",
        terms: ["a", "b"],
      }),
    ).toBe('ModGuy unblocked "a", "b"');
    expect(describeModAction({ ...base, action: "add_permitted_term" })).toBe(
      "ModGuy permitted a term",
    );
    expect(
      describeModAction({
        ...base,
        action: "remove_permitted_term",
        terms: ["x"],
      }),
    ).toBe('ModGuy removed permitted "x"');
    expect(
      describeModAction({
        ...base,
        action: "approve_unban_request",
        moderator_message: "ok",
      }),
    ).toBe("ModGuy approved an unban request from Spammer: ok");
    expect(describeModAction({ ...base, action: "deny_unban_request" })).toBe(
      "ModGuy denied an unban request from Spammer",
    );
  });

  it("falls back to logins and generic names when Twitch omits them", () => {
    expect(
      describeModAction({
        ...base,
        action: "ban",
        moderator_name: "",
        target_user_name: "",
      }),
    ).toBe("modguy banned spammer");
    expect(
      describeModAction({
        ...base,
        action: "ban",
        moderator_name: "",
        moderator_login: "",
        target_user_name: "",
        target_user_login: "",
      }),
    ).toBe("A moderator banned a user");
  });
});
