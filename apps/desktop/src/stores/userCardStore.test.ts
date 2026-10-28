import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardUser } from "../components/UserCard";

const gates = new Map<string, () => void>();
const preloadImages = vi.fn<(urls: string[]) => Promise<void>>(() =>
  Promise.resolve(),
);

vi.mock("./userInfoStore", () => ({
  loadUserInfo: (ids: string[]) =>
    new Promise<void>((resolve) => gates.set(ids[0], resolve)),
  userInfo: (id: string) =>
    id === "1" ? { profile_image_url: "https://img/1.png" } : undefined,
}));
vi.mock("../lib/preload", () => ({
  preloadImages: (urls: string[]) => preloadImages(urls),
}));

const { openUserCard, closeUserCard, cardUser, cardLoading, cardOrigin } =
  await import("./userCardStore");

const user = (id: string): CardUser => ({
  channel_id: "c",
  platform_user_id: id,
  username: `u${id}`,
  display_name: `U${id}`,
  color: null,
  badges: [],
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("user card", () => {
  beforeEach(() => {
    closeUserCard();
    gates.clear();
    preloadImages.mockClear();
  });

  it("waits for the profile and avatar before opening", async () => {
    openUserCard(user("1"), "msg-1");
    expect(cardLoading()).toBe("msg-1");
    expect(cardUser()).toBeNull();
    gates.get("1")!();
    await settle();
    expect(preloadImages).toHaveBeenCalledWith(["https://img/1.png"]);
    expect(cardLoading()).toBeNull();
    expect(cardOrigin()).toBe("msg-1");
    expect(cardUser()?.platform_user_id).toBe("1");
  });

  it("preloads nothing when the profile is unknown", async () => {
    openUserCard(user("2"), "msg-2");
    gates.get("2")!();
    await settle();
    expect(preloadImages).toHaveBeenCalledWith([""]);
    expect(cardUser()?.platform_user_id).toBe("2");
  });

  it("drops a load overtaken by a newer open", async () => {
    openUserCard(user("1"), "a");
    openUserCard(user("2"), "b");
    gates.get("2")!();
    await settle();
    expect(cardOrigin()).toBe("b");
    gates.get("1")!();
    await settle();
    expect(cardOrigin()).toBe("b");
    expect(cardUser()?.platform_user_id).toBe("2");
  });

  it("closing cancels a pending open", async () => {
    openUserCard(user("1"), "a");
    closeUserCard();
    expect(cardLoading()).toBeNull();
    gates.get("1")!();
    await settle();
    expect(cardUser()).toBeNull();
    expect(cardOrigin()).toBeNull();
  });
});
