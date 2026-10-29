import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

const [me, setMe] = createSignal<string | null>("42");
vi.mock("../stores/authStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/authStore")>()),
  currentUserId: () => me(),
}));
vi.mock("../stores/channelStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/channelStore")>()),
  activeChannel: () => null,
}));
vi.mock("../stores/userInfoStore", () => ({
  ensureUserInfo: () => {},
  userInfo: () => undefined,
  userInfoRevision: () => 0,
}));
vi.mock("./AccountPanel", () => ({ default: () => null }));

const { default: AccountAvatar } = await import("./AccountAvatar");

describe("AccountAvatar", () => {
  afterEach(cleanup);

  it("stays in the header with no channel open, until signed out", () => {
    const [attention, setAttention] = createSignal<{ text: string } | null>(
      null,
    );
    render(() => (
      <AccountAvatar
        login="viewer"
        attention={attention()}
        onSignOut={() => {}}
      />
    ));
    expect(
      screen.getByRole("button", { name: "Your account, chatting as viewer" }),
    ).toBeTruthy();
    expect(document.querySelector(".avatar__dot")).toBeNull();
    setAttention({ text: "Twitch needs new permissions" });
    expect(document.querySelector(".avatar__dot")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Settings needs you/ }).title,
    ).toContain("Twitch needs new permissions");
    setMe(null);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
