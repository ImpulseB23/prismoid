import { afterEach, describe, expect, it, vi } from "vitest";
import type { Paint, PaintSnapshot, UserPaint } from "./paintStore";

const invokeMock = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return unlisten;
  },
}));

const { createPaintStore, syncPaints, shownPaint } =
  await import("./paintStore");
const { updateSettings } = await import("./settingsStore");

const firebrand: Paint = {
  id: "01HEBYHWN0000EV2G1SJ85XJQR",
  name: "Firebrand",
  function: "RADIAL_GRADIENT",
  angle: 0,
  shape: "circle",
  repeat: false,
  stops: [{ at: 0.15, color: "#fff700ff" }],
  shadows: [],
};
const ghoulish: Paint = {
  ...firebrand,
  id: "ghoulish",
  name: "Ghoulish",
  function: "LINEAR_GRADIENT",
  angle: 90,
};

afterEach(() => {
  invokeMock.mockReset();
  handlers.clear();
  unlisten.mockReset();
});

describe("paintStore", () => {
  it("resolves a user's paint once both have arrived", () => {
    const store = createPaintStore();
    store.assign([{ user_id: "472256554", paint_id: firebrand.id }]);
    expect(store.paintFor("472256554")).toBeUndefined();
    store.addPaint(firebrand);
    expect(store.paintFor("472256554")).toBe(firebrand);

    store.assign([{ user_id: "472256554", paint_id: null }]);
    expect(store.paintFor("472256554")).toBeUndefined();
    expect(store.paintFor("nobody")).toBeUndefined();
  });

  it("merges a snapshot over what events already set", () => {
    const store = createPaintStore();
    store.addPaint(ghoulish);
    store.assign([{ user_id: "2", paint_id: ghoulish.id }]);
    store.load({
      paints: [firebrand],
      users: [{ user_id: "1", paint_id: firebrand.id }],
    });
    expect(store.paintFor("1")).toBe(firebrand);
    expect(store.paintFor("2")).toBe(ghoulish);
  });

  it("syncs from host events and the snapshot", async () => {
    const snapshot: PaintSnapshot = {
      paints: [firebrand],
      users: [{ user_id: "1", paint_id: firebrand.id }],
    };
    invokeMock.mockResolvedValueOnce(snapshot);
    const store = createPaintStore();
    const stop = await syncPaints(store);
    expect(invokeMock).toHaveBeenCalledWith("current_seventv_paints");
    expect(store.paintFor("1")).toBe(firebrand);

    handlers.get("seventv_paint")!({ payload: ghoulish });
    const users: UserPaint[] = [
      { user_id: "1", paint_id: null },
      { user_id: "3", paint_id: ghoulish.id },
    ];
    handlers.get("seventv_paint_users")!({ payload: users });
    expect(store.paintFor("1")).toBeUndefined();
    expect(store.paintFor("3")).toBe(ghoulish);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("keeps listening when the snapshot fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error("no state"));
    const store = createPaintStore();
    await syncPaints(store);
    expect(error).toHaveBeenCalled();
    handlers.get("seventv_paint")!({ payload: firebrand });
    handlers.get("seventv_paint_users")!({
      payload: [{ user_id: "1", paint_id: firebrand.id }],
    });
    expect(store.paintFor("1")).toBe(firebrand);
    error.mockRestore();
  });

  it("hides paints when the setting is off", async () => {
    invokeMock.mockResolvedValueOnce({
      paints: [firebrand],
      users: [{ user_id: "1", paint_id: firebrand.id }],
    });
    await syncPaints();
    expect(shownPaint("1")).toEqual(firebrand);
    await updateSettings({ showPaints: false });
    expect(shownPaint("1")).toBeUndefined();
    await updateSettings({ showPaints: true });
  });
});
