import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import StreamVideo, { playerUrl, videoSize } from "./StreamVideo";

describe("videoSize", () => {
  it("is the smallest player Twitch allows, at 16:9", () => {
    expect(videoSize(1280, 800)).toEqual({ width: 534, height: 300 });
  });

  it("narrows toward 400 in a narrow chat", () => {
    expect(videoSize(450, 800)).toEqual({ width: 426, height: 300 });
  });

  it("says which way a chat misses Twitch's 400x300 minimum", () => {
    expect(videoSize(420, 800)).toBe("narrow");
    expect(videoSize(900, 320)).toBe("short");
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

const onPopOut = vi.fn();
const onClose = vi.fn();

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
        <StreamVideo
          login="pgl"
          name="PGL"
          onPopOut={onPopOut}
          onClose={onClose}
        />
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
    expect(frame.width).toBe("534");
    expect(frame.height).toBe("300");
  });

  it("pops out and closes from the bar above the player", () => {
    mountIn(800, 1000);
    fireEvent.click(
      screen.getByRole("button", { name: "Watch in its own window" }),
    );
    expect(onPopOut).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close the preview" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says so in a chat too narrow or too short for the player", () => {
    mountIn(300, 1000);
    expect(screen.queryByTitle("PGL's stream")).toBeNull();
    expect(screen.getByText(/Widen this pane/)).toBeTruthy();
    cleanup();
    mountIn(900, 320);
    expect(screen.getByText(/window taller/)).toBeTruthy();
  });
});
