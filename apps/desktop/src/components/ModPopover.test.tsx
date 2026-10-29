import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const missing = { scopes: [] as string[] };
vi.mock("../stores/authStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/authStore")>()),
  warnNeedsReconnect: () =>
    missing.scopes.includes("moderator:manage:warnings"),
}));
vi.mock("./TwitchReconnect", () => ({
  default: (p: { title: string }) => <p>{p.title}</p>,
}));

const { default: ModPopover, customSeconds } = await import("./ModPopover");
const { closeModPopover, modPopover, openModPopover } =
  await import("../stores/modPopoverStore");

describe("ModPopover", () => {
  afterEach(() => {
    closeModPopover();
    cleanup();
    missing.scopes = [];
  });

  it("times out for a preset or a custom length", () => {
    const submit = vi.fn();
    render(() => <ModPopover />);
    openModPopover({
      kind: "timeout",
      x: 10,
      y: 10,
      target: "Viewer",
      presets: [60, 600],
      submit,
    });
    fireEvent.click(screen.getByRole("button", { name: "10m" }));
    expect(submit).toHaveBeenLastCalledWith(600);
    expect(modPopover()).toBeNull();

    openModPopover({
      kind: "timeout",
      x: 10,
      y: 10,
      target: "Viewer",
      presets: [60],
      submit,
    });
    fireEvent.input(screen.getByRole("spinbutton", { name: "Length" }), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Unit" }), {
      target: { value: "3600" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Timeout" }));
    expect(submit).toHaveBeenLastCalledWith(7200);
  });

  it("warns only with a reason", () => {
    const submit = vi.fn();
    render(() => <ModPopover />);
    openModPopover({ kind: "warn", x: 0, y: 0, target: "Viewer", submit });
    const warn = screen.getByRole("button", { name: "Warn" });
    expect((warn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: "  no spoilers " },
    });
    fireEvent.click(warn);
    expect(submit).toHaveBeenCalledWith("no spoilers");
  });

  it("asks for the reconnect before a first warning", () => {
    missing.scopes = ["moderator:manage:warnings"];
    render(() => <ModPopover />);
    openModPopover({
      kind: "warn",
      x: 0,
      y: 0,
      target: "Viewer",
      submit: vi.fn(),
    });
    expect(screen.getByText("Warn needs one more permission")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
  });

  it("closes on Escape", () => {
    render(() => <ModPopover />);
    openModPopover({
      kind: "warn",
      x: 0,
      y: 0,
      target: "Viewer",
      submit: vi.fn(),
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(modPopover()).toBeNull();
  });
});

describe("customSeconds", () => {
  it("turns a length and unit into seconds within Twitch's cap", () => {
    expect(customSeconds("90", 1)).toBe(90);
    expect(customSeconds("14", 86_400)).toBe(1_209_600);
    expect(customSeconds("15", 86_400)).toBeNull();
    expect(customSeconds("0", 60)).toBeNull();
    expect(customSeconds("1.5", 60)).toBeNull();
    expect(customSeconds("", 60)).toBeNull();
  });
});
