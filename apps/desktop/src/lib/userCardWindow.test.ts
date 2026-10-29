import { describe, expect, it, vi } from "vitest";
import type { CardUser } from "../components/UserCard";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(
  async () => null,
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));

type Handler = (e: { payload: CardUser }) => void;
const listen = vi.fn<(event: string, handler: Handler) => Promise<() => void>>(
  async () => () => {},
);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen }),
}));

const {
  cardReady,
  closeUserCard,
  currentCardUser,
  isCardWindow,
  isUserCardError,
  loadUserHistory,
  onCardUser,
  openUserCard,
  setCardPinned,
  userPaint,
} = await import("./userCardWindow");

const user: CardUser = {
  channel_id: "c",
  platform_user_id: "42",
  username: "ann",
  display_name: "Ann",
  color: null,
  badges: [],
};

describe("userCardWindow", () => {
  it("keys card windows on the label prefix", () => {
    expect(isCardWindow("user-card-1")).toBe(true);
    expect(isCardWindow("main")).toBe(false);
    expect(isCardWindow("user-card")).toBe(false);
  });

  it("calls the host commands", async () => {
    await openUserCard(user, 1.25);
    expect(invoke).toHaveBeenLastCalledWith("user_card_open", {
      user,
      zoom: 1.25,
    });
    await currentCardUser();
    expect(invoke).toHaveBeenLastCalledWith("user_card_current", undefined);
    await cardReady();
    expect(invoke).toHaveBeenLastCalledWith("user_card_ready", undefined);
    await setCardPinned(true);
    expect(invoke).toHaveBeenLastCalledWith("user_card_set_pinned", {
      pinned: true,
    });
    await closeUserCard();
    expect(invoke).toHaveBeenLastCalledWith("user_card_close", undefined);
    await loadUserHistory("c", "42", 20);
    expect(invoke).toHaveBeenLastCalledWith("chat_history_user", {
      channelId: "c",
      userId: "42",
      limit: 20,
    });
    await userPaint("42");
    expect(invoke).toHaveBeenLastCalledWith("seventv_user_paint", {
      userId: "42",
    });
  });

  it("hands reuse announcements to the handler", async () => {
    const seen: CardUser[] = [];
    await onCardUser((u) => seen.push(u));
    expect(listen.mock.calls[0][0]).toBe("user_card_show");
    listen.mock.calls[0][1]({ payload: user });
    expect(seen).toEqual([user]);
  });

  it("passes host errors through", async () => {
    invoke.mockRejectedValueOnce({ kind: "window", message: "no monitor" });
    const caught: unknown = await openUserCard(user, 1).catch(
      (e: unknown) => e,
    );
    expect(isUserCardError(caught) && caught.kind).toBe("window");
  });

  it("accepts only host error shapes", () => {
    expect(isUserCardError({ kind: "not_a_card", message: "x" })).toBe(true);
    expect(isUserCardError({ kind: "other", message: "x" })).toBe(false);
    expect(isUserCardError({ kind: "window" })).toBe(false);
    expect(isUserCardError("window")).toBe(false);
    expect(isUserCardError(null)).toBe(false);
  });
});
