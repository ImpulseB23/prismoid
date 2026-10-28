import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.6.0"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
const autostart = { on: false };
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn(async () => autostart.on),
  enable: vi.fn(async () => {
    autostart.on = true;
  }),
  disable: vi.fn(async () => {
    throw new Error("registry locked");
  }),
}));

const { default: Settings } = await import("./Settings");
const { settings } = await import("../stores/settingsStore");

describe("Settings", () => {
  afterEach(cleanup);

  it("reads start with Windows from the system and reverts a failed toggle", async () => {
    render(() => (
      <Settings open login="me" onClose={() => {}} onSignOut={() => {}} />
    ));
    const startup = screen.getByRole("checkbox", {
      name: /Start with Windows/,
    }) as HTMLInputElement;
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(startup);
    await vi.waitFor(() => expect(startup.checked).toBe(true));
    expect(autostart.on).toBe(true);
    fireEvent.click(startup);
    await vi.waitFor(() =>
      expect(screen.getByText("registry locked")).toBeTruthy(),
    );
    expect(startup.checked).toBe(true);

    const tray = screen.getByRole("checkbox", {
      name: /Close to tray/,
    }) as HTMLInputElement;
    fireEvent.click(tray);
    await vi.waitFor(() => expect(settings().closeToTray).toBe(true));
  });

  it("toggles badge highlights and saves highlighted users", async () => {
    render(() => (
      <Settings open login="me" onClose={() => {}} onSignOut={() => {}} />
    ));
    const vips = screen.getByRole("button", { name: "VIPs" });
    fireEvent.click(vips);
    await vi.waitFor(() => expect(settings().highlightBadges).toContain("vip"));
    expect(vips.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(vips);
    await vi.waitFor(() =>
      expect(settings().highlightBadges).not.toContain("vip"),
    );

    const rows = screen.getByRole("checkbox", {
      name: /Alternating rows/,
    });
    fireEvent.click(rows);
    await vi.waitFor(() => expect(settings().alternateRows).toBe(true));

    const users = screen.getByPlaceholderText("bestfriend, cohost");
    fireEvent.change(users, { target: { value: "Friend, cohost" } });
    await vi.waitFor(() =>
      expect(settings().highlightUsers).toEqual(["friend", "cohost"]),
    );
  });
});
