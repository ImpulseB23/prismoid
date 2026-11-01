import { describe, expect, it } from "vitest";
import {
  fitsLimit,
  formatSendError,
  normalizeOutgoing,
  toSendError,
} from "./messageInput";

describe("normalizeOutgoing", () => {
  it("returns null for empty/whitespace", () => {
    expect(normalizeOutgoing("")).toBeNull();
    expect(normalizeOutgoing("   ")).toBeNull();
    expect(normalizeOutgoing("\n\t")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOutgoing("  hello  ")).toBe("hello");
  });
});

describe("fitsLimit", () => {
  it("accepts short ascii", () => {
    expect(fitsLimit("hello")).toBe(true);
  });

  it("rejects payloads larger than 500 bytes", () => {
    expect(fitsLimit("a".repeat(501))).toBe(false);
  });

  it("counts utf-8 bytes, not code units", () => {
    // Each emoji is 4 bytes in UTF-8; 126 of them = 504 bytes.
    expect(fitsLimit("🔥".repeat(126))).toBe(false);
    expect(fitsLimit("🔥".repeat(125))).toBe(true);
  });
});

describe("formatSendError", () => {
  it("formats each variant", () => {
    expect(formatSendError({ kind: "empty_message" })).toMatch(/empty/i);
    expect(
      formatSendError({ kind: "message_too_long", max_bytes: 500 }),
    ).toContain("500");
    expect(formatSendError({ kind: "sidecar_not_running" })).toMatch(
      /connecting/i,
    );
    expect(formatSendError({ kind: "not_logged_in", message: "x" })).toMatch(
      /sign in/i,
    );
    // Raw error text never reaches the status line.
    expect(formatSendError({ kind: "auth", message: "boom" })).toMatch(
      /^Your Twitch sign-in needs a refresh/,
    );
    expect(formatSendError({ kind: "io", message: "pipe" })).not.toContain(
      "pipe",
    );
    expect(formatSendError({ kind: "json", message: "bad" })).not.toContain(
      "bad",
    );
    expect(
      formatSendError({
        kind: "helix",
        code: "msg_duplicate",
        message: "Your message is identical to the one you sent.",
      }),
    ).toBe("Your message is identical to the one you sent.");
    expect(
      formatSendError({
        kind: "helix",
        code: "",
        message: "twitch helix: status 400",
      }),
    ).toBe("Twitch did not take the message. Try again in a moment.");
    expect(
      formatSendError({ kind: "helix", code: "unauthorized", message: "x" }),
    ).toMatch(/reconnect/i);
    expect(
      formatSendError({
        kind: "message_too_long_chars",
        max_chars: 200,
      }),
    ).toContain("200");
    expect(
      formatSendError({
        kind: "youtube",
        code: "unauthorized",
        message: "x",
      }),
    ).toMatch(/sign in/i);
    expect(
      formatSendError({
        kind: "youtube",
        code: "quota_exceeded",
        message: "x",
      }),
    ).toMatch(/quota/i);
    expect(
      formatSendError({
        kind: "youtube",
        code: "youtube_api",
        message: "chat ended",
      }),
    ).toMatch(/^YouTube did not take the message/);
    expect(
      formatSendError({ kind: "youtube", code: "", message: "blocked" }),
    ).not.toContain("blocked");
  });
});

describe("formatSendError for mod actions", () => {
  const mod = (code: string, status: number) =>
    formatSendError({ kind: "moderation", code, status });

  it("words each refusal by status", () => {
    expect(mod("unauthorized", 401)).toMatch(/reconnect/i);
    expect(mod("rate_limited", 429)).toMatch(/a moment/);
    expect(mod("helix", 403)).toMatch(/moderator/);
    expect(mod("helix", 400)).toBe("Twitch does not allow that here.");
    expect(mod("helix", 404)).toBe("That is no longer there.");
    expect(mod("helix", 409)).toMatch(/someone else/i);
    expect(mod("helix", 503)).toMatch(/trouble/);
    expect(mod("helix", 0)).toBe(
      "Twitch did not do that. Try again in a moment.",
    );
  });
});

describe("toSendError", () => {
  it("passes through valid structured errors", () => {
    const err = { kind: "empty_message" };
    expect(toSendError(err)).toBe(err);
    const helix = { kind: "helix", code: "x", message: "y" };
    expect(toSendError(helix)).toBe(helix);
  });

  it("accepts every known variant when shape matches", () => {
    const cases = [
      { kind: "empty_message" },
      { kind: "sidecar_not_running" },
      { kind: "not_logged_in", message: "x" },
      { kind: "io", message: "x" },
      { kind: "auth", message: "x" },
      { kind: "json", message: "x" },
      { kind: "message_too_long", max_bytes: 500 },
      { kind: "message_too_long_chars", max_chars: 200 },
      { kind: "helix", code: "c", message: "m" },
      { kind: "youtube", code: "c", message: "m" },
      { kind: "moderation", code: "helix", status: 400 },
    ];
    for (const c of cases) {
      expect(toSendError(c)).toBe(c);
    }
  });

  it("rejects look-alike objects with the wrong shape", () => {
    // missing required `max_bytes`
    expect(toSendError({ kind: "message_too_long" })).toBe("[object Object]");
    // wrong type for required field
    expect(toSendError({ kind: "io", message: 5 })).toBe("[object Object]");
    // unknown variant
    expect(toSendError({ kind: "made_up_kind" })).toBe("[object Object]");
    // arrays should not be accepted
    expect(toSendError([{ kind: "empty_message" }])).not.toMatchObject({
      kind: "empty_message",
    });
  });

  it("stringifies unknown shapes", () => {
    expect(toSendError("nope")).toBe("nope");
    expect(toSendError(null)).toBe("null");
  });
});
