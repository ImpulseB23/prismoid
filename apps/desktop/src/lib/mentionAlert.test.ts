import { describe, expect, it, vi } from "vitest";
import { ALERT_GAP_MS, createMentionAlert } from "./mentionAlert";

function setup(focused = false) {
  let t = 0;
  let isFocused = focused;
  const chime = vi.fn();
  const flash = vi.fn(async () => {});
  const alert = createMentionAlert({
    focused: () => isFocused,
    flash,
    chime,
    now: () => t,
  });
  return {
    alert,
    chime,
    flash,
    advance: (ms: number) => (t += ms),
    focus: (f: boolean) => (isFocused = f),
  };
}

describe("mentionAlert", () => {
  it("pings once per burst while the window is in the background", () => {
    const s = setup();
    s.alert.notify();
    s.alert.notify();
    expect(s.chime).toHaveBeenCalledOnce();
    expect(s.flash).toHaveBeenCalledOnce();
    s.advance(ALERT_GAP_MS);
    s.alert.notify();
    expect(s.chime).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while focused", () => {
    const s = setup(true);
    s.alert.notify();
    expect(s.chime).not.toHaveBeenCalled();
    s.focus(false);
    s.alert.notify();
    expect(s.chime).toHaveBeenCalledOnce();
  });

  it("logs a flash that fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = createMentionAlert({
      focused: () => false,
      chime: () => {},
      flash: async () => {
        throw new Error("denied");
      },
    });
    alert.notify();
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith("flash window", expect.any(Error));
    error.mockRestore();
  });
});
