import { describe, expect, it } from "vitest";
import { chatPieces, mentionedUser, mentionify } from "./mentions";
import { createChatterStore } from "../stores/chatterStore";

const text = (t: string) => mentionify([{ kind: "text", text: t }]);

describe("mentionify", () => {
  it("splits out @names with their login", () => {
    expect(text("hey @Caedrel, gg @x_y")).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", text: "@Caedrel", login: "caedrel" },
      { kind: "text", text: ", gg " },
      { kind: "mention", text: "@x_y", login: "x_y" },
    ]);
  });

  it("leaves emails, lone @ and over-long names alone", () => {
    expect(text("me@example.com")).toEqual([
      { kind: "text", text: "me@example.com" },
    ]);
    expect(text("@ nobody")).toEqual([{ kind: "text", text: "@ nobody" }]);
    expect(text(`@${"a".repeat(26)}`)).toEqual([
      { kind: "text", text: `@${"a".repeat(26)}` },
    ]);
  });

  it("finds a mention that starts the message", () => {
    expect(text("@streamer hi")[0]).toEqual({
      kind: "mention",
      text: "@streamer",
      login: "streamer",
    });
  });
});

describe("chatPieces", () => {
  it("finds links and mentions together", () => {
    const kinds = chatPieces("@a see https://x.co", [], {
      maxHeight: 20,
    }).map((p) => p.kind);
    expect(kinds).toEqual(["mention", "text", "link"]);
  });
});

describe("mentionedUser", () => {
  const channel = {
    id: "9",
    login: "caedrel",
    display_name: "Caedrel",
    profile_image_url: "",
  };
  const lookup = async (login: string) => ({
    id: "5",
    login,
    display_name: "Lurker",
    profile_image_url: "",
  });

  it("prefers someone who spoke, then the streamer, then a lookup", async () => {
    const chatters = createChatterStore();
    chatters.record("1", "viewer", "Viewer", "#00FF00", 1);
    expect(await mentionedUser("viewer", chatters, channel, lookup)).toEqual({
      id: "1",
      login: "viewer",
      display_name: "Viewer",
      color: "#00FF00",
    });
    expect((await mentionedUser("caedrel", chatters, channel, lookup)).id).toBe(
      "9",
    );
    expect(await mentionedUser("lurker", chatters, channel, lookup)).toEqual({
      id: "5",
      login: "lurker",
      display_name: "Lurker",
      color: null,
    });
  });
});
