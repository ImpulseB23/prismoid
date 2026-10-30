import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const sent: [string, string, unknown][] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  },
  emitTo: async (target: string, name: string, payload: unknown) => {
    sent.push([target, name, payload]);
  },
}));
const invoke = vi.fn(async () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const video = await import("./videoWindow");

describe("videoWindow", () => {
  beforeEach(() => {
    handlers.clear();
    sent.length = 0;
  });

  it("knows its windows by label", () => {
    expect(video.isVideoWindow("video-caedrel")).toBe(true);
    expect(video.isVideoWindow("main")).toBe(false);
    expect(video.videoWindowLogin("video-caedrel")).toBe("caedrel");
  });

  it("counts a channel out until its window closes", async () => {
    const stop = await video.followVideoWindows(() => {});
    await video.openVideoWindow("caedrel", "Caedrel's stream");
    expect(invoke).toHaveBeenCalledWith("video_window_open", {
      login: "caedrel",
      title: "Caedrel's stream",
    });
    expect(video.isPoppedOut("caedrel")).toBe(true);
    handlers.get("video_window_closed")!({ payload: "caedrel" });
    expect(video.isPoppedOut("caedrel")).toBe(false);
    stop();
    expect(handlers.size).toBe(0);
  });

  it("closes every pop-out", async () => {
    await video.closeVideoWindows();
    expect(invoke).toHaveBeenCalledWith("video_windows_close");
  });

  it("hands a stream back to the main window", async () => {
    const popIn = vi.fn();
    await video.followVideoWindows(popIn);
    await video.popBackIn("caedrel");
    expect(sent).toEqual([["main", "video_pop_in", "caedrel"]]);
    handlers.get("video_pop_in")!({ payload: "caedrel" });
    expect(popIn).toHaveBeenCalledWith("caedrel");
  });
});
