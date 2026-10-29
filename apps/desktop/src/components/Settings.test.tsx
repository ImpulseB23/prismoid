import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { Update } from "@tauri-apps/plugin-updater";

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

const markSeen = vi.fn();
vi.mock("../stores/whatsNewStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/whatsNewStore")>()),
  markWhatsNewSeen: () => markSeen(),
}));

const chime = vi.fn();
vi.mock("../lib/mentionAlert", () => ({
  playChime: (volume: number) => chime(volume),
}));

const { default: Settings } = await import("./Settings");
const { settings } = await import("../stores/settingsStore");
const { check } = await import("@tauri-apps/plugin-updater");

describe("Settings", () => {
  afterEach(cleanup);

  it("reads start with Windows from the system and reverts a failed toggle", async () => {
    render(() => (
      <Settings
        open
        login="me"
        attentions={[]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Window" }));
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
      <Settings
        open
        login="me"
        attentions={[]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const vips = screen.getByRole("button", { name: "VIPs" });
    fireEvent.click(vips);
    await vi.waitFor(() => expect(settings().highlightBadges).toContain("vip"));
    expect(vips.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(vips);
    await vi.waitFor(() =>
      expect(settings().highlightBadges).not.toContain("vip"),
    );

    const appearance = screen.getByRole("button", { name: "Appearance" });
    fireEvent.click(appearance);
    expect(appearance.getAttribute("aria-current")).toBe("page");
    const rows = screen.getByRole("checkbox", {
      name: /Alternating rows/,
    });
    fireEvent.click(rows);
    await vi.waitFor(() => expect(settings().alternateRows).toBe(true));

    fireEvent.click(screen.getByRole("checkbox", { name: /7TV name paints/ }));
    await vi.waitFor(() => expect(settings().showPaints).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const users = screen.getByPlaceholderText("bestfriend, cohost");
    fireEvent.change(users, { target: { value: "Friend, cohost" } });
    await vi.waitFor(() =>
      expect(settings().highlightUsers).toEqual(["friend", "cohost"]),
    );
  });

  it("marks the sections and rows that need the user", () => {
    render(() => (
      <Settings
        open
        login="me"
        attentions={[
          { text: "Set up Prismoid", section: "help", row: "setup" },
          { text: "Updated to 0.8.2", section: "updates", row: "update" },
        ]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    const tab = (name: string) => screen.getByRole("button", { name });
    expect(tab("Help, needs attention")).toBeTruthy();
    expect(tab("Updates, needs attention")).toBeTruthy();
    expect(tab("Chat")).toBeTruthy();

    fireEvent.click(tab("Help, needs attention"));
    const setup = screen.getByText("Setup").closest(".settings__row")!;
    expect(setup.classList).toContain("settings__row--attention");
  });

  it("previews the mention chime at the chosen volume", async () => {
    render(() => (
      <Settings
        open
        login="me"
        attentions={[]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.change(screen.getByRole("slider", { name: "Chime volume" }), {
      target: { value: "0.5" },
    });
    await vi.waitFor(() => expect(settings().chimeVolume).toBe(0.5));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(chime).toHaveBeenCalledWith(0.5);
  });

  it("counts the update notes seen once Updates is left", () => {
    markSeen.mockClear();
    render(() => (
      <Settings
        open
        login="me"
        attentions={[]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    expect(markSeen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(markSeen).toHaveBeenCalledOnce();
  });

  it("shows versions without a trailing .0", async () => {
    vi.mocked(check).mockResolvedValueOnce({
      version: "0.7.0",
      downloadAndInstall: vi.fn(),
    } as unknown as Update);
    render(() => (
      <Settings
        open
        login="me"
        attentions={[]}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    await vi.waitFor(() =>
      expect(screen.getByText("Prismoid v0.6")).toBeTruthy(),
    );
    const checkButton = screen.getByRole("button", {
      name: "Check for updates",
    });
    expect(checkButton.classList.contains("btn--outline")).toBe(true);
    fireEvent.click(checkButton);
    await vi.waitFor(() =>
      expect(screen.getByText("Version 0.7 is available")).toBeTruthy(),
    );
    const install = screen.getByRole("button", { name: "Install and restart" });
    expect(install.classList.contains("btn--primary")).toBe(true);
  });
});
