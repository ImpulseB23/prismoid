import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, textMetrics } from "./messageLayout";

describe("textMetrics", () => {
  it("keeps the original proportions at the default size", () => {
    const m = textMetrics(DEFAULT_TEXT_SIZE);
    expect(m.lineHeight).toBe(22);
    expect(m.timestampSize).toBe(12);
    expect(m.badgeSize).toBe(18);
    expect(m.textFont).toContain("400 15px");
  });

  it("scales every size up together and caches per size", () => {
    const big = textMetrics(TEXT_SIZES.at(-1)!);
    expect(big.lineHeight).toBeGreaterThan(big.fontSize);
    expect(big.badgeSize).toBeGreaterThan(18);
    expect(textMetrics(TEXT_SIZES.at(-1)!)).toBe(big);
  });
});
