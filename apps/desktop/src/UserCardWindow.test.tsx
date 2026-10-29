import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import type { CardUser } from "./components/UserCard";

const minimize = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize,
    onScaleChanged: async () => () => {},
    scaleFactor: async () => 1,
  }),
}));
const setZoom = vi.fn(async () => {});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let announce: ((u: CardUser) => void) | undefined;
const card = {
  currentCardUser: vi.fn<() => Promise<CardUser | null>>(),
  cardReady: vi.fn(async () => {}),
  setCardPinned: vi.fn<(pinned: boolean) => Promise<void>>(async () => {}),
  closeUserCard: vi.fn(async () => {}),
  onCardUser: vi.fn(async (handler: (u: CardUser) => void) => {
    announce = handler;
    return () => {};
  }),
};
vi.mock("./lib/userCardWindow", () => card);

const session = {
  startCardSession: vi.fn(async () => () => {}),
  showCardUser: vi.fn<(u: CardUser) => Promise<() => void>>(
    async () => () => {},
  ),
};
vi.mock("./lib/cardSession", () => session);
const bridge = { sendMention: vi.fn(), sendJump: vi.fn() };
vi.mock("./lib/cardBridge", () => bridge);
// The card itself is tested on its own; here it only has to show who it
// is for and pass its callbacks through.
vi.mock("./components/UserCard", () => ({
  default: (p: {
    user: CardUser | null;
    onMention: (login: string) => void;
  }) => (
    <button type="button" onClick={() => p.onMention(p.user!.username)}>
      {p.user ? `${p.user.display_name} (@${p.user.username})` : ""}
    </button>
  ),
}));

const { default: UserCardWindow } = await import("./UserCardWindow");

const user = (name: string): CardUser => ({
  channel_id: "c",
  platform_user_id: `id-${name}`,
  username: name,
  display_name: name.toUpperCase(),
  color: null,
  badges: [],
});

describe("UserCardWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    announce = undefined;
  });
  afterEach(cleanup);

  it("shows the current user, then asks to be shown", async () => {
    card.currentCardUser.mockResolvedValue(user("ann"));
    render(() => <UserCardWindow />);
    await waitFor(() => expect(card.cardReady).toHaveBeenCalledOnce());
    expect(screen.getByText("ANN (@ann)")).toBeTruthy();
  });

  it("switches user on a reuse, even ahead of a stale answer", async () => {
    let answer: (u: CardUser) => void = () => {};
    card.currentCardUser.mockReturnValue(
      new Promise((resolve) => (answer = resolve)),
    );
    render(() => <UserCardWindow />);
    await waitFor(() => expect(announce).toBeDefined());
    announce!(user("bob"));
    answer(user("ann"));
    await waitFor(() => expect(card.cardReady).toHaveBeenCalled());
    expect(screen.getByText("BOB (@bob)")).toBeTruthy();
    expect(screen.queryByText("ANN (@ann)")).toBeNull();
  });

  it("loads each person it shows and hands mentions to the main window", async () => {
    card.currentCardUser.mockResolvedValue(user("ann"));
    render(() => <UserCardWindow />);
    await waitFor(() =>
      expect(session.showCardUser).toHaveBeenCalledWith(user("ann")),
    );
    expect(session.startCardSession).toHaveBeenCalledOnce();
    announce!(user("bob"));
    await waitFor(() =>
      expect(session.showCardUser).toHaveBeenLastCalledWith(user("bob")),
    );
    fireEvent.click(screen.getByRole("button", { name: "BOB (@bob)" }));
    expect(bridge.sendMention).toHaveBeenCalledWith("bob");
  });

  it("applies the app's zoom to the card", async () => {
    card.currentCardUser.mockResolvedValue(user("ann"));
    render(() => <UserCardWindow />);
    await waitFor(() => expect(setZoom).toHaveBeenCalled());
  });

  it("still shows when the user cannot be loaded", async () => {
    card.currentCardUser.mockRejectedValue(new Error("gone"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(() => <UserCardWindow />);
    await waitFor(() => expect(card.cardReady).toHaveBeenCalledOnce());
    error.mockRestore();
  });

  it("pins, minimizes only while pinned, and closes", async () => {
    card.currentCardUser.mockResolvedValue(user("ann"));
    render(() => <UserCardWindow />);
    expect(screen.queryByRole("button", { name: "Minimize card" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pin card" }));
    expect(card.setCardPinned).toHaveBeenLastCalledWith(true);
    const unpin = await screen.findByRole("button", { name: "Unpin card" });
    expect(unpin.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Minimize card" }));
    expect(minimize).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Close card" }));
    expect(card.closeUserCard).toHaveBeenCalledOnce();
  });
});
