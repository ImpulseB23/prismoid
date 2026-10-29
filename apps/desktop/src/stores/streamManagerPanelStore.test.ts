import { describe, expect, it } from "vitest";
import {
  streamManagerOpen,
  toggleStreamManager,
} from "./streamManagerPanelStore";

describe("streamManagerPanelStore", () => {
  it("toggles the curtain", () => {
    expect(streamManagerOpen()).toBe(false);
    toggleStreamManager();
    expect(streamManagerOpen()).toBe(true);
    toggleStreamManager();
    expect(streamManagerOpen()).toBe(false);
  });
});
