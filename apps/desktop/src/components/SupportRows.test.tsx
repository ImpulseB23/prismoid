import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async () => {});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));
const relaunch = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

const { default: SupportRows } = await import("./SupportRows");

const button = (name: string) => screen.getByRole("button", { name });

describe("support rows", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    invoke.mockClear();
    relaunch.mockClear();
    writeText.mockClear();
    localStorage.clear();
  });

  it("copies the support bundle", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce("Prismoid 0.6.0\nlog lines");
    render(() => <SupportRows />);
    fireEvent.click(button("Copy logs"));
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith("support_bundle");
    expect(writeText).toHaveBeenCalledWith("Prismoid 0.6.0\nlog lines");
    expect(button("Copied")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(button("Copy logs")).toBeTruthy();
  });

  it("shows why copying failed", async () => {
    invoke.mockRejectedValueOnce(new Error("no log file"));
    render(() => <SupportRows />);
    fireEvent.click(button("Copy logs"));
    expect((await screen.findByRole("alert")).textContent).toBe("no log file");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("resets settings on the second tap and restarts", async () => {
    localStorage.setItem("prismoid.settings", "{}");
    localStorage.setItem("prismoid.tabs", "[]");
    render(() => <SupportRows />);
    fireEvent.click(button("Reset settings"));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(button("Reset and restart?"));
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("reset_settings");
    expect(localStorage.getItem("prismoid.settings")).toBeNull();
    expect(localStorage.getItem("prismoid.tabs")).toBe("[]");
  });

  it("erases every app key on a full reset", async () => {
    localStorage.setItem("prismoid.settings", "{}");
    localStorage.setItem("prismoid.tabs", "[]");
    localStorage.setItem("other", "keep");
    render(() => <SupportRows />);
    fireEvent.click(button("Reset everything"));
    fireEvent.click(button("Erase everything?"));
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("reset_all_data");
    expect(Object.keys(localStorage)).toEqual(["other"]);
  });

  it("stops a failed reset before restarting", async () => {
    localStorage.setItem("prismoid.settings", "{}");
    invoke.mockRejectedValueOnce({ kind: "sign_out", message: "keyring" });
    render(() => <SupportRows />);
    fireEvent.click(button("Reset everything"));
    fireEvent.click(button("Erase everything?"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Reset stopped: keyring",
    );
    expect(relaunch).not.toHaveBeenCalled();
    expect(localStorage.getItem("prismoid.settings")).toBe("{}");
    expect(button("Reset settings").hasAttribute("disabled")).toBe(false);
  });

  it("starts the uninstaller on the second tap", async () => {
    render(() => <SupportRows />);
    fireEvent.click(button("Uninstall"));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(button("Uninstall Prismoid?"));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("uninstall_app"),
    );
    expect(button("Uninstall").hasAttribute("disabled")).toBe(true);
  });

  it.each([
    [
      "not_installed",
      "This copy wasn't installed with the installer. Uninstall it from Windows Settings > Apps.",
    ],
    ["launch_failed", "The uninstaller would not start: access denied"],
  ])("explains a %s uninstall", async (kind, text) => {
    invoke.mockRejectedValueOnce({ kind, message: "access denied" });
    render(() => <SupportRows />);
    fireEvent.click(button("Uninstall"));
    fireEvent.click(button("Uninstall Prismoid?"));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
  });
});
