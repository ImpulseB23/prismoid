import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

const setFullscreen = vi.fn<(on: boolean) => Promise<void>>(async () => {});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "video-caedrel", setFullscreen }),
}));

const { default: VideoWindow } = await import("./VideoWindow");

describe("VideoWindow", () => {
  afterEach(cleanup);

  it("plays the channel named by its window", () => {
    render(() => <VideoWindow />);
    const frame = screen.getByTitle("caedrel's stream") as HTMLIFrameElement;
    expect(new URL(frame.src).searchParams.get("channel")).toBe("caedrel");
  });

  it("follows the player into and out of fullscreen", () => {
    render(() => <VideoWindow />);
    const frame = screen.getByTitle("caedrel's stream");
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => frame,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => null,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
  });
});
