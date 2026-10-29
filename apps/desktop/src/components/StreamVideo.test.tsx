import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import StreamVideo, { playerUrl, videoSize } from "./StreamVideo";

describe("videoSize", () => {
  it("fills the pane width at 16:9", () => {
    expect(videoSize(800, 1000)).toEqual({ width: 800, height: 450 });
  });

  it("keeps room for chat by going narrower, not adding bars", () => {
    expect(videoSize(1280, 584)).toEqual({ width: 682, height: 384 });
  });

  it("says which way a pane misses Twitch's 400x300 minimum", () => {
    expect(videoSize(399, 2000)).toBe("narrow");
    expect(videoSize(700, 480)).toBe("short");
  });
});

describe("playerUrl", () => {
  it("names the channel and the page's host as the parent", () => {
    const url = new URL(playerUrl("pgl", "tauri.localhost"));
    expect(url.origin).toBe("https://player.twitch.tv");
    expect(url.searchParams.get("channel")).toBe("pgl");
    expect(url.searchParams.get("parent")).toBe("tauri.localhost");
    expect(url.searchParams.get("autoplay")).toBe("true");
  });
});

describe("StreamVideo", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountIn(width: number, height: number) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      width,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
      height,
    );
    render(() => (
      <div>
        <StreamVideo login="pgl" name="PGL" />
      </div>
    ));
  }

  it("plays the stream in a sandboxed frame that cannot leave", () => {
    mountIn(800, 1000);
    const frame = screen.getByTitle("PGL's stream") as HTMLIFrameElement;
    expect(new URL(frame.src).searchParams.get("channel")).toBe("pgl");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-presentation",
    );
    expect(frame.width).toBe("800");
    expect(frame.height).toBe("450");
  });

  it("says so in a pane too narrow or too short for the player", () => {
    mountIn(300, 1000);
    expect(screen.queryByTitle("PGL's stream")).toBeNull();
    expect(screen.getByText(/at least 400px wide/)).toBeTruthy();
    cleanup();
    mountIn(900, 450);
    expect(screen.getByText(/window taller/)).toBeTruthy();
  });
});
