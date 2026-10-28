import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.6.0"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const { default: Settings } = await import("./Settings");
const { settings } = await import("../stores/settingsStore");

describe("Settings", () => {
  afterEach(cleanup);

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
