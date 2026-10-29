import { describe, expect, it, vi } from "vitest";
import { createTourStore } from "./tourStore";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn() }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setAlwaysOnTop: vi.fn() }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const STEPS = [
  { title: "a", body: "" },
  { title: "b", body: "", section: "appearance" as const },
  { title: "c", body: "" },
];

function store(done = false, fresh = true) {
  let isDone = done;
  const markDone = vi.fn(async () => {
    isDone = true;
  });
  const settingsOpen = vi.fn();
  const tour = createTourStore(
    STEPS,
    () => isDone,
    markDone,
    settingsOpen,
    () => fresh,
  );
  return { tour, markDone, settingsOpen };
}

describe("tourStore", () => {
  it("offers itself once and remembers when it is finished", async () => {
    const { tour, markDone } = store();
    tour.offer();
    expect(tour.step()).toBe(0);
    tour.next();
    tour.next();
    expect(tour.step()).toBe(2);
    tour.next();
    await Promise.resolve();
    expect(tour.step()).toBeNull();
    expect(markDone).toHaveBeenCalledOnce();
    tour.offer();
    expect(tour.step()).toBeNull();
  });

  it("leaves an updated install to the Settings badge", () => {
    const { tour } = store(false, false);
    tour.offer();
    expect(tour.step()).toBeNull();
  });

  it("opens Settings only for Settings steps", () => {
    const { tour, settingsOpen } = store();
    tour.start();
    tour.next();
    expect(settingsOpen).toHaveBeenLastCalledWith("appearance");
    tour.next();
    expect(settingsOpen).toHaveBeenLastCalledWith(null);
  });

  it("does not offer itself after it was done", () => {
    const { tour } = store(true);
    tour.offer();
    expect(tour.step()).toBeNull();
  });

  it("can be replayed without saving again", async () => {
    const { tour, markDone } = store(true);
    tour.start();
    expect(tour.step()).toBe(0);
    await tour.finish();
    expect(tour.step()).toBeNull();
    expect(markDone).not.toHaveBeenCalled();
  });

  it("steps back but not past the start", () => {
    const { tour } = store();
    tour.start();
    tour.back();
    expect(tour.step()).toBe(0);
    tour.next();
    tour.back();
    expect(tour.step()).toBe(0);
  });

  it("skipping counts as done", async () => {
    const { tour, markDone } = store();
    tour.offer();
    await tour.finish();
    expect(markDone).toHaveBeenCalledOnce();
  });
});
