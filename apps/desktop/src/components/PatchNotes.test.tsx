import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const openUrl = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

const { showPatchNotes, patchNotes } = await import("../stores/whatsNewStore");
const { default: PatchNotes } = await import("./PatchNotes");
const { RELEASE_NOTES, notesSince } = await import("../releaseNotes");

describe("PatchNotes", () => {
  afterEach(cleanup);

  it("shows the notes and closes on Got it", () => {
    render(() => <PatchNotes />);
    expect(screen.queryByRole("dialog")).toBeNull();
    showPatchNotes(RELEASE_NOTES[0]!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(RELEASE_NOTES[0]!.headline);
    fireEvent.click(screen.getByRole("button", { name: "Full changelog" }));
    expect(openUrl).toHaveBeenCalledWith(
      `https://github.com/ImpulseB23/Prismoid/releases/tag/v${RELEASE_NOTES[0]!.version}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(patchNotes()).toBeNull();
  });

  it("groups the notes into new, improved and fixed, leaving out empty ones", () => {
    render(() => <PatchNotes />);
    const headings = () =>
      screen.queryAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    showPatchNotes({
      version: "9.9.9",
      headline: "Test",
      features: [{ title: "Split view", body: "Chats side by side" }],
      improvements: ["Faster"],
      fixes: ["No crash"],
    });
    expect(headings()).toEqual(["New", "Improved", "Fixed"]);
    const text = screen.getByRole("dialog").textContent;
    expect(text).toContain("Chats side by side");
    expect(text).toContain("No crash");

    showPatchNotes({
      version: "9.9.10",
      headline: "Test",
      features: [],
      improvements: [],
      fixes: ["No crash"],
    });
    expect(headings()).toEqual(["Fixed"]);
  });

  it("takes you to the settings a new feature needs", async () => {
    const { settingsOpen, settingsSection } =
      await import("../stores/settingsPanelStore");
    render(() => <PatchNotes />);
    showPatchNotes({
      version: "9.9.11",
      headline: "Test",
      features: [
        {
          title: "Faster sending",
          body: "Sign in again once.",
          action: { label: "Open Twitch settings", section: "account" },
        },
      ],
      improvements: [],
      fixes: [],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open Twitch settings" }),
    );
    expect(patchNotes()).toBeNull();
    expect(settingsOpen()).toBe(true);
    expect(settingsSection()).toBe("account");
  });

  it("closes on Escape", () => {
    render(() => <PatchNotes />);
    showPatchNotes(RELEASE_NOTES[0]!);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("notesSince", () => {
  const notes = (v: string) => RELEASE_NOTES.find((n) => n.version === v);

  it("finds the notes of the version updated to", () => {
    expect(notesSince("0.7.0", "0.8.0")).toBe(notes("0.8.0"));
  });

  it("still shows a skipped release's notes", () => {
    expect(notesSince("0.7.0", "0.8.1")).toBe(notes("0.8.0"));
    expect(notesSince("0.5.0", "0.8.1")).toBe(notes("0.8.0"));
  });

  it("has nothing once those notes were seen", () => {
    expect(notesSince("0.8.0", "0.8.1")).toBeUndefined();
    expect(notesSince("0.8.1", "0.8.0")).toBeUndefined();
  });

  it("finds the newest notes up to a version", () => {
    expect(notesSince("0.0.0", "0.8.1")).toBe(notes("0.8.0"));
    expect(notesSince("0.0.0", "")).toBeUndefined();
  });
});
