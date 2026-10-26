import { describe, expect, it } from "vitest";
import { formatUptime, formatViewers } from "./streamInfo";

describe("formatViewers", () => {
  it("compacts thousands and millions", () => {
    expect(formatViewers(999)).toBe("999");
    expect(formatViewers(1200)).toBe("1.2K");
    expect(formatViewers(2000)).toBe("2K");
    expect(formatViewers(45_678)).toBe("46K");
    expect(formatViewers(1_500_000)).toBe("1.5M");
  });
});

describe("formatUptime", () => {
  const start = "2026-10-24T20:00:00Z";
  it("shows minutes under an hour and h m above", () => {
    expect(formatUptime(start, Date.parse(start) + 5 * 60_000)).toBe("5m");
    expect(formatUptime(start, Date.parse(start) + 125 * 60_000)).toBe(
      "2h 05m",
    );
  });

  it("returns empty for an unparsable start", () => {
    expect(formatUptime("nope", 0)).toBe("");
  });
});
