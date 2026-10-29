import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

const [ready, setReady] = createSignal(true);
const [color, setColor] = createSignal<string | null>("#1E90FF");
const updateChatColor = vi.fn<(c: string) => Promise<void>>(async () => {});
const loadOwnColor = vi.fn(async () => setColor("#FF4500"));
const openUrl = vi.fn<(url: string) => Promise<void>>(async () => {});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (u: string) => openUrl(u),
}));
vi.mock("../lib/chatSession", () => ({
  useSession: () => () => ({
    channel: { id: "c", login: "chan", display_name: "Chan" },
    badges: {
      revision: () => 0,
      resolve: () => ({
        title: "VIP",
        url_1x: "v1",
        url_2x: "v2",
        url_4x: "v4",
      }),
    },
  }),
}));
vi.mock("../lib/twitchChannel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/twitchChannel")>()),
  updateChatColor: (c: string) => updateChatColor(c),
}));
vi.mock("../stores/authStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/authStore")>()),
  currentUserId: () => "1",
  scopeGroupReady: () => ready(),
}));
vi.mock("../stores/ownIdentityStore", () => ({
  loadOwnColor: () => loadOwnColor(),
  ownBadges: () => [{ set_id: "vip", id: "1" }],
  ownColor: () => color(),
  ownDisplayName: () => "Viewer",
}));
vi.mock("./streamManager/ScopeGroupCard", () => ({
  default: (p: { group: string }) => <p>opt in to {p.group}</p>,
}));

const { default: ChatIdentity } = await import("./ChatIdentity");

describe("ChatIdentity", () => {
  afterEach(() => {
    cleanup();
    setReady(true);
    setColor("#1E90FF");
    updateChatColor.mockReset();
  });

  it("previews the name and badges and asks for access first", () => {
    setReady(false);
    render(() => <ChatIdentity login="viewer" />);
    expect(screen.getByText("Viewer")).toBeTruthy();
    expect(screen.getByAltText("VIP")).toBeTruthy();
    expect(screen.getByText("opt in to chat_color")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("saves a named color and shows the one Twitch has", async () => {
    render(() => <ChatIdentity login="viewer" />);
    expect(
      screen
        .getByRole("radio", { name: "Dodger blue" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Orange red" }));
    await vi.waitFor(() =>
      expect(
        screen
          .getByRole("radio", { name: "Orange red" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(updateChatColor).toHaveBeenCalledWith("orange_red");
  });

  it("explains that custom colors need Turbo or Prime", async () => {
    updateChatColor.mockRejectedValue({
      kind: "color_needs_turbo",
      message: "",
    });
    render(() => <ChatIdentity login="viewer" />);
    fireEvent.input(screen.getByLabelText("Custom color"), {
      target: { value: "#123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use custom color" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Turbo or Prime/,
    );
    expect(updateChatColor).toHaveBeenCalledWith("#123456");
  });

  it("links to the channel's chat on Twitch for badges", () => {
    render(() => <ChatIdentity login="viewer" />);
    fireEvent.click(screen.getByRole("button", { name: /Chan's chat/ }));
    expect(openUrl).toHaveBeenCalledWith(
      "https://www.twitch.tv/popout/chan/chat",
    );
  });
});
