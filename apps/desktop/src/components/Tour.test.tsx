import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn() }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setAlwaysOnTop: vi.fn() }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { default: Tour } = await import("./Tour");
const { TOUR_STEPS, startTour, tourStep } = await import("../stores/tourStore");

describe("Tour", () => {
  afterEach(cleanup);

  it("walks through every step and closes on Done", () => {
    render(() => <Tour />);
    expect(screen.queryByRole("dialog")).toBeNull();
    startTour();
    expect(screen.getByRole("dialog").textContent).toContain(
      TOUR_STEPS[0].title,
    );
    for (let i = 1; i < TOUR_STEPS.length; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("dialog").textContent).toContain(
        TOUR_STEPS[i].title,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(tourStep()).toBeNull();
  });

  it("rings a Settings section and lets its controls through", async () => {
    const section = document.createElement("section");
    section.dataset.tour = "settings-content";
    document.body.append(section);
    render(() => <Tour />);
    startTour();
    const at = TOUR_STEPS.findIndex((s) => s.section === "appearance");
    for (let i = 0; i < at; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    await Promise.resolve();
    expect(document.querySelector(".tour__ring")).not.toBeNull();
    expect(document.querySelector(".tour--interactive")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(tourStep()).toBeNull();
    section.remove();
  });
});
