import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";

const win = {
  label: "video-caedrel",
  title: vi.fn(async () => "Caedrel's stream"),
  setFullscreen: vi.fn<(on: boolean) => Promise<void>>(async () => {}),
  setAlwaysOnTop: vi.fn<(on: boolean) => Promise<void>>(async () => {}),
  close: vi.fn(async () => {}),
};
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("./stores/windowStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stores/windowStore")>()),
  trackWindowChrome: async () => () => {},
}));
const popBackIn = vi.fn<(login: string) => Promise<void>>(async () => {});
vi.mock("./lib/videoWindow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/videoWindow")>()),
  popBackIn: (login: string) => popBackIn(login),
}));

const { default: VideoWindow } = await import("./VideoWindow");

function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => el,
  });
  document.dispatchEvent(new Event("fullscreenchange"));
}

describe("VideoWindow", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("plays the channel named by its window under its own title bar", async () => {
    render(() => <VideoWindow />);
    const frame = screen.getByTitle("caedrel's stream") as HTMLIFrameElement;
    expect(new URL(frame.src).searchParams.get("channel")).toBe("caedrel");
    expect(await screen.findByText("Caedrel's stream")).toBeTruthy();
  });

  it("goes back into chat and closes", async () => {
    render(() => <VideoWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(popBackIn).toHaveBeenCalledWith("caedrel");
    await waitFor(() => expect(win.close).toHaveBeenCalledOnce());
  });

  it("pins above other windows and lets go again", async () => {
    render(() => <VideoWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Keep on top" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop keeping on top" }),
      ).toBeTruthy(),
    );
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop keeping on top" }),
    );
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it("follows the player into fullscreen and hides the bar meanwhile", () => {
    render(() => <VideoWindow />);
    setFullscreenElement(screen.getByTitle("caedrel's stream"));
    expect(win.setFullscreen).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("button", { name: "Back to chat" })).toBeNull();
    setFullscreenElement(null);
    expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "Back to chat" })).toBeTruthy();
  });
});
