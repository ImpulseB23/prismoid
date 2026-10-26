import { describe, expect, it } from "vitest";
import { isHighlighted, mentionsLogin } from "./highlight";

describe("mentionsLogin", () => {
  it("matches @handle and bare login as whole words", () => {
    expect(mentionsLogin("hey @Tester what up", "tester")).toBe(true);
    expect(mentionsLogin("tester: hi", "tester")).toBe(true);
    expect(mentionsLogin("TESTER", "tester")).toBe(true);
  });

  it("does not match inside other words", () => {
    expect(mentionsLogin("contester lol", "tester")).toBe(false);
    expect(mentionsLogin("tester1", "tester")).toBe(false);
    expect(mentionsLogin("anything", "")).toBe(false);
  });
});

describe("isHighlighted", () => {
  it("also matches configured phrases case-insensitively", () => {
    expect(isHighlighted("GG Prismoid rocks", "tester", ["prismoid"])).toBe(
      true,
    );
    expect(isHighlighted("nothing here", "tester", ["prismoid"])).toBe(false);
    expect(isHighlighted("nothing here", "tester", [])).toBe(false);
  });
});
