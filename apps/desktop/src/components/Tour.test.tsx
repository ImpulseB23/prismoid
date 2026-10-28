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

  it("rings the targeted control and offers the two switches", () => {
    const anchor = document.createElement("button");
    anchor.dataset.tour = "settings";
    document.body.append(anchor);
    render(() => <Tour />);
    startTour();
    const toggles = TOUR_STEPS.findIndex((s) => s.toggles);
    for (let i = 0; i < toggles; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(document.querySelector(".tour__ring")).not.toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(tourStep()).toBeNull();
    anchor.remove();
  });
});
