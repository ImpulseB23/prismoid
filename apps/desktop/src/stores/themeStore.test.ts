import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";

const [stored, setStored] = createSignal({
  theme: "dark",
  readableColors: true,
});
vi.mock("./settingsStore", () => ({ settings: () => stored() }));

const { nameContrast, resolvePalette } = await import("./themeStore");

describe("resolvePalette", () => {
  it("follows the OS only for system", () => {
    expect(resolvePalette("system", true)).toBe("dark");
    expect(resolvePalette("system", false)).toBe("light");
    expect(resolvePalette("midnight", false)).toBe("midnight");
    expect(resolvePalette("light", true)).toBe("light");
  });
});

describe("nameContrast", () => {
  it("follows the palette unless readable colors is off", () => {
    expect(nameContrast()).toBe("dark");
    setStored({ theme: "light", readableColors: true });
    expect(nameContrast()).toBe("light");
    setStored({ theme: "light", readableColors: false });
    expect(nameContrast()).toBe("off");
  });
});
