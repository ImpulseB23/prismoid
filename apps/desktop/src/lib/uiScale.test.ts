import { describe, expect, it } from "vitest";
import { baseZoom, snapTo } from "./uiScale";

describe("uiScale", () => {
  it("only adds what Windows scaling leaves out", () => {
    expect(baseZoom(1)).toBe(1.5);
    expect(baseZoom(1.25)).toBeCloseTo(1.2);
    expect(baseZoom(1.5)).toBe(1);
    expect(baseZoom(2)).toBe(1);
  });

  it("snaps to the nearest step", () => {
    expect(snapTo([1, 1.25, 1.5], 1.3)).toBe(1.25);
    expect(snapTo([14, 20, 22], 21.4)).toBe(22);
  });
});
