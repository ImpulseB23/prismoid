import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const openUrl = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

const { showPatchNotes, patchNotes } = await import("../stores/whatsNewStore");
const { default: PatchNotes } = await import("./PatchNotes");
const { RELEASE_NOTES, notesFor } = await import("../releaseNotes");

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

  it("closes on Escape", () => {
    render(() => <PatchNotes />);
    showPatchNotes(RELEASE_NOTES[0]!);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("notesFor", () => {
  it("finds notes by version", () => {
    expect(notesFor(RELEASE_NOTES[0]!.version)).toBe(RELEASE_NOTES[0]);
    expect(notesFor("0.0.0")).toBeUndefined();
  });
});
