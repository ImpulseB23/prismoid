import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { UserInfo } from "../lib/twitchChannel";

const ensureUserInfo = vi.fn();
const profiles = new Map<string, UserInfo>();
vi.mock("../stores/userInfoStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/userInfoStore")>()),
  ensureUserInfo: (ids: string[]) => ensureUserInfo(ids),
  userInfo: (id: string) => profiles.get(id),
  userInfoRevision: () => 0,
}));
vi.mock("../lib/preload", () => ({ preloadImages: async () => {} }));

const { default: ChatHoverCard } = await import("./ChatHoverCard");
const { chatHover, endChatHover, hoverBadge, hoverUser } =
  await import("../stores/chatHoverStore");
const { HOVER_DELAY_MS } = await import("../stores/emoteCardStore");

const badge = {
  title: "6-Month Subscriber",
  url_1x: "s1",
  url_2x: "s2",
  url_4x: "s4",
};
const anchor = () => {
  const el = document.createElement("span");
  document.body.append(el);
  return el;
};
const wait = () => new Promise((r) => setTimeout(r, HOVER_DELAY_MS + 10));

describe("ChatHoverCard", () => {
  afterEach(() => {
    endChatHover();
    cleanup();
    document.body.innerHTML = "";
    profiles.clear();
  });

  it("shows a badge large with its name after a moment", async () => {
    render(() => <ChatHoverCard />);
    hoverBadge(anchor(), badge);
    expect(chatHover()).toBeNull();
    await wait();
    expect(screen.getByRole("tooltip").textContent).toBe("6-Month Subscriber");
    expect(screen.getByRole("tooltip").querySelector("img")?.src).toContain(
      "s4",
    );
    endChatHover();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("drops a hover the pointer already left", async () => {
    hoverBadge(anchor(), badge);
    endChatHover();
    await wait();
    expect(chatHover()).toBeNull();
  });

  it("shows who a name belongs to and how old the account is", async () => {
    profiles.set("7", {
      id: "7",
      login: "newbie",
      display_name: "Newbie",
      profile_image_url: "https://example.test/p.png",
      description: "",
      created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      broadcaster_type: "",
    });
    render(() => <ChatHoverCard />);
    hoverUser(anchor(), {
      userId: "7",
      login: "newbie",
      displayName: "日本語",
      nameStyle: { color: "#ff0000" },
      painted: false,
    });
    expect(ensureUserInfo).toHaveBeenCalledWith(["7"]);
    await wait();
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("日本語");
    expect(tip.textContent).toContain("newbie");
    expect(screen.getByText("Joined 2 days ago").className).toContain(
      "user-tip__joined--new",
    );
  });

  it("closes when the user scrolls", async () => {
    render(() => <ChatHoverCard />);
    hoverBadge(anchor(), badge);
    await wait();
    window.dispatchEvent(new WheelEvent("wheel"));
    expect(chatHover()).toBeNull();
  });
});
