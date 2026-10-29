import { describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: { from: string } }) => void;
let onChanged: Handler | undefined;
const emitted: unknown[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (_event: string, payload: unknown) => {
    emitted.push(payload);
  }),
  listen: vi.fn(async (_event: string, cb: Handler) => {
    onChanged = cb;
    return () => (onChanged = undefined);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "user-card-1" }),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

const { followSettingsElsewhere, settings, updateSettings } =
  await import("./settingsStore");

describe("settings across windows", () => {
  it("announces saves and re-reads what other windows save", async () => {
    const stop = await followSettingsElsewhere();
    await updateSettings({ highlightUsers: ["kit"] });
    expect(emitted).toEqual([{ from: "user-card-1" }]);

    localStorage.setItem(
      "prismoid.settings",
      JSON.stringify({ ...settings(), highlightUsers: ["nova"], v: 2 }),
    );
    onChanged!({ payload: { from: "user-card-1" } });
    expect(settings().highlightUsers).toEqual(["kit"]);
    onChanged!({ payload: { from: "main" } });
    expect(settings().highlightUsers).toEqual(["nova"]);

    stop();
    expect(onChanged).toBeUndefined();
    await updateSettings({ highlightUsers: [] });
    expect(emitted).toHaveLength(1);
  });
});
