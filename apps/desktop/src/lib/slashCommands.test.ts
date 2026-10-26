import { describe, expect, it } from "vitest";
import { formatSeconds, parseDuration, parseInput } from "./slashCommands";

describe("formatSeconds", () => {
  it("uses the largest units that fit", () => {
    expect(formatSeconds(600)).toBe("10m");
    expect(formatSeconds(5400)).toBe("1h 30m");
    expect(formatSeconds(90061)).toBe("1d 1h 1m 1s");
    expect(formatSeconds(0)).toBe("0s");
  });
});

describe("parseDuration", () => {
  it("reads seconds and unit suffixes", () => {
    expect(parseDuration("600")).toBe(600);
    expect(parseDuration("10m")).toBe(600);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("2d")).toBe(172_800);
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("10x")).toBeNull();
  });
});

describe("parseInput", () => {
  it("passes plain text and escaped slashes through", () => {
    expect(parseInput("hello")).toEqual({ kind: "message", text: "hello" });
    expect(parseInput("//shrug")).toEqual({ kind: "message", text: "//shrug" });
  });

  it("parses ban, unban and timeout with optional parts", () => {
    expect(parseInput("/ban @Spammer being rude")).toEqual({
      kind: "command",
      command: { kind: "ban", login: "spammer", reason: "being rude" },
    });
    expect(parseInput("/unban spammer")).toEqual({
      kind: "command",
      command: { kind: "unban", login: "spammer" },
    });
    expect(parseInput("/timeout spammer")).toEqual({
      kind: "command",
      command: {
        kind: "timeout",
        login: "spammer",
        seconds: 600,
        reason: undefined,
      },
    });
    expect(parseInput("/timeout spammer 1h calm down")).toEqual({
      kind: "command",
      command: {
        kind: "timeout",
        login: "spammer",
        seconds: 3600,
        reason: "calm down",
      },
    });
    expect(parseInput("/timeout spammer calm down")).toEqual({
      kind: "command",
      command: {
        kind: "timeout",
        login: "spammer",
        seconds: 600,
        reason: "calm down",
      },
    });
  });

  it("rejects bad usage and unknown commands", () => {
    expect(parseInput("/ban").kind).toBe("error");
    expect(parseInput("/timeout x 3w").kind).toBe("error");
    expect(parseInput("/dance").kind).toBe("error");
    expect(parseInput("/me")).toEqual({
      kind: "error",
      message: "Usage: /me <text>",
    });
    expect(parseInput("/me waves")).toEqual({
      kind: "command",
      command: { kind: "me", text: "waves" },
    });
  });
});
