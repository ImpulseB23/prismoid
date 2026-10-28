import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const win = {
  isDecorated: vi.fn(async () => false),
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn<(cb: () => void) => Promise<() => void>>(
    async () => () => {},
  ),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const { trackWindowChrome, customChrome, maximized } =
  await import("../stores/windowStore");
const { default: WindowControls } = await import("./WindowControls");
const { default: TitleBar } = await import("./TitleBar");

describe("window chrome", () => {
  afterEach(cleanup);

  it("stays native on a decorated window", async () => {
    win.isDecorated.mockResolvedValueOnce(true);
    await trackWindowChrome();
    expect(customChrome()).toBe(false);
    expect(win.onResized).not.toHaveBeenCalled();
    render(() => <TitleBar />);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("draws the buttons and follows maximize", async () => {
    await trackWindowChrome();
    expect(customChrome()).toBe(true);
    render(() => <WindowControls />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(win.minimize).toHaveBeenCalledOnce();
    expect(win.toggleMaximize).toHaveBeenCalledOnce();
    expect(win.close).toHaveBeenCalledOnce();

    win.isMaximized.mockResolvedValueOnce(true);
    const onResized = win.onResized.mock.calls[0]![0];
    onResized();
    await vi.waitFor(() => expect(maximized()).toBe(true));
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });
});
