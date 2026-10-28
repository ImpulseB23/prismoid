import { describe, expect, it } from "vitest";
import { resolvePalette } from "./themeStore";

describe("resolvePalette", () => {
  it("follows the OS only for system", () => {
    expect(resolvePalette("system", true)).toBe("dark");
    expect(resolvePalette("system", false)).toBe("light");
    expect(resolvePalette("midnight", false)).toBe("midnight");
    expect(resolvePalette("light", true)).toBe("light");
  });
});
