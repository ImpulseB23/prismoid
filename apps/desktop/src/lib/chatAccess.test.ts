import { describe, expect, it } from "vitest";
import { bannedNotice, bannedText } from "./chatAccess";

const channel = {
  id: "42",
  login: "forsen",
  display_name: "Forsen",
  profile_image_url: "",
};

describe("chatAccess", () => {
  it("uses the channel name in the ban text", () => {
    expect(bannedText("Forsen")).toBe("You are banned from talking in Forsen.");
  });

  it("builds a notice row scoped to the channel", () => {
    const row = bannedNotice(channel, 7);
    expect(row.channel_id).toBe("42");
    expect(row.arrival_seq).toBe(7);
    expect(row.notice).toEqual({
      notice_type: "banned",
      system_message: "You are banned from talking in Forsen.",
    });
    expect(row.message_text).toBe("");
  });
});
