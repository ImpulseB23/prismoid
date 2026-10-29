import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

type Stored = { showTimestamps: boolean; readableColors: boolean };
const [stored, setStored] = createSignal<Stored>({
  showTimestamps: false,
  readableColors: true,
});
const updateSettings = vi.fn(async (patch: Partial<Stored>) => {
  setStored((s) => ({ ...s, ...patch }));
});
vi.mock("../stores/settingsStore", () => ({
  settings: () => stored(),
  updateSettings: (patch: Partial<Stored>) => updateSettings(patch),
}));

const { default: ChatSettingsMenu } = await import("./ChatSettingsMenu");

function mount() {
  const [open, setOpen] = createSignal(true);
  const gear = document.createElement("button");
  document.body.append(gear);
  render(() => (
    <ChatSettingsMenu
      open={open()}
      anchor={gear}
      onClose={() => setOpen(false)}
    />
  ));
  return { open, gear };
}

describe("ChatSettingsMenu", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("saves each switch", () => {
    mount();
    const timestamps = screen.getByRole("checkbox", { name: /Timestamps/ });
    fireEvent.click(timestamps);
    expect(updateSettings).toHaveBeenCalledWith({ showTimestamps: true });
    expect((timestamps as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Readable colors/ }));
    expect(updateSettings).toHaveBeenCalledWith({ readableColors: false });
  });

  it("closes on an outside press or Escape, not on its gear", () => {
    const { open, gear } = mount();
    fireEvent.mouseDown(gear);
    expect(open()).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(open()).toBe(false);

    cleanup();
    const again = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(again.open()).toBe(false);
    expect(document.activeElement).toBe(again.gear);
  });
});
