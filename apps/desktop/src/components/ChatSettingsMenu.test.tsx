import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

type Stored = {
  showTimestamps: boolean;
  readableColors: boolean;
  pauseChat: string;
  animatedEmotes: boolean;
};
const [stored, setStored] = createSignal<Stored>({
  showTimestamps: false,
  readableColors: true,
  pauseChat: "scroll",
  animatedEmotes: true,
});
const updateSettings = vi.fn(async (patch: Partial<Stored>) => {
  setStored((s) => ({ ...s, ...patch }));
});
vi.mock("../stores/settingsStore", () => ({
  settings: () => stored(),
  updateSettings: (patch: Partial<Stored>) => updateSettings(patch),
  PAUSE_CHAT: ["scroll", "hover", "alt", "hoverAlt"],
}));

vi.mock("./ChatIdentity", () => ({
  default: (p: { login: string }) => <p>identity of {p.login}</p>,
}));

const { default: ChatSettingsMenu } = await import("./ChatSettingsMenu");

function mount() {
  const [open, setOpen] = createSignal(true);
  const gear = document.createElement("button");
  document.body.append(gear);
  render(() => (
    <ChatSettingsMenu
      open={open()}
      login="viewer"
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
    fireEvent.click(screen.getByRole("checkbox", { name: /Animated emotes/ }));
    expect(updateSettings).toHaveBeenCalledWith({ animatedEmotes: false });
    const pause = screen.getByRole("combobox", { name: /Pause chat/ });
    fireEvent.change(pause, { target: { value: "hoverAlt" } });
    expect(updateSettings).toHaveBeenCalledWith({ pauseChat: "hoverAlt" });
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

  it("opens chat identity and comes back", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Chat identity/ }));
    expect(screen.getByText("identity of viewer")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Timestamps/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to chat settings" }),
    );
    expect(screen.getByRole("checkbox", { name: /Timestamps/ })).toBeTruthy();
  });
});
