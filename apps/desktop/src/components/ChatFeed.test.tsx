import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ChatMessage } from "../stores/chatStore";
import type { PreparedMessage, TextMetrics } from "../lib/messageLayout";

const handlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const role = { mod: false };
vi.mock("../stores/roleStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/roleStore")>()),
  canModerate: () => role.mod,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention: vi.fn() }),
  UserAttentionType: { Informational: 2 },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../stores/channelStore", () => ({
  activeChannel: () => ({ id: "chan", login: "chan", display_name: "Chan" }),
  channelBanned: () => false,
  channelTabs: () => [],
  channelStatus: () => "connected",
  markChannelBanned: vi.fn(),
  focusChannel: vi.fn(async () => {}),
  noteUnread: vi.fn(),
  rejoinChannel: vi.fn(),
}));
vi.mock("../stores/userInfoStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/userInfoStore")>()),
  ensureUserInfo: () => {},
  userInfo: () => undefined,
}));
vi.mock("../lib/chatHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatHistory")>()),
  loadHistory: async () => [],
}));
vi.mock("../lib/emoteBundle", () => ({ currentEmoteBundle: async () => null }));
// Pretext needs a canvas, which jsdom lacks; layout is covered by its own
// module, here only the row classes matter.
vi.mock("../lib/messageLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/messageLayout")>()),
  prepareMessage: (
    msg: ChatMessage,
    _resolve: unknown,
    opts: { metrics?: TextMetrics },
  ): Partial<PreparedMessage> => ({
    pieces: [{ kind: "text", text: msg.message_text }],
    badges: [],
    timestamp: "",
    replyParent: null,
    notice: null,
    metrics: opts.metrics,
  }),
  measureMessageHeight: () => 26,
  firstLabelWidth: () => 80,
}));

const { invoke } = await import("@tauri-apps/api/core");
const { setAuthStatus } = await import("../stores/authStore");
const { clearJump, jumpRequest, jumpToMessage } =
  await import("../stores/jumpStore");
const { focusChannel } = await import("../stores/channelStore");
const { notice } = await import("../stores/noticeStore");
const { ownBadges } = await import("../stores/ownIdentityStore");
const { closeContextMenu, contextMenu } =
  await import("../stores/contextMenuStore");
const { closeModPopover, modPopover } =
  await import("../stores/modPopoverStore");
const { updateSettings } = await import("../stores/settingsStore");
const { default: ChatFeed } = await import("./ChatFeed");
const { default: ChatPane } = await import("./ChatPane");
const { activeChannel } = await import("../stores/channelStore");

// The feed draws the session of the pane it sits in.
const renderFeed = (login: string) =>
  render(() => (
    <ChatPane channel={activeChannel()}>
      <ChatFeed login={login} />
    </ChatPane>
  ));
const { startChatRouter } = await import("../lib/chatRouter");

let seq = 0;
const msg = (id: string): ChatMessage =>
  ({
    id,
    platform: "Twitch",
    timestamp: ++seq,
    arrival_time: seq,
    effective_ts: seq,
    arrival_seq: seq,
    username: "viewer",
    display_name: "Viewer",
    platform_user_id: "7",
    channel_id: "chan",
    message_text: `hello ${id}`,
    badges: [],
    color: null,
    emote_spans: [],
    notice: null,
    reply_parent: null,
  }) as unknown as ChatMessage;

const emit = (name: string, payload: unknown) =>
  handlers.get(name)!({ payload });
// The chat store publishes batches on the next animation frame.
const tick = () => new Promise((r) => requestAnimationFrame(r));

function rowFor(container: HTMLElement, id: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".msg")].find((el) =>
    el.textContent?.includes(`hello ${id}`),
  );
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("ChatFeed", () => {
  let stopRouter: () => void;

  beforeEach(async () => {
    stopRouter = await startChatRouter(() => "me");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  });

  afterEach(async () => {
    stopRouter();
    cleanup();
    handlers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await updateSettings({ highlightFirstMessages: true });
    role.mod = false;
    closeModPopover();
    clearJump();
  });

  it("opens the timeout picker and the warn box from a mod's hover bar", async () => {
    role.mod = true;
    renderFeed("me");
    await tick();
    emit("chat_messages", [msg("rude")]);
    await tick();

    fireEvent.click(screen.getByRole("button", { name: "Timeout" }));
    const timeout = modPopover();
    if (timeout?.kind !== "timeout") throw new Error("no timeout picker");
    expect(timeout.target).toBe("Viewer");
    timeout.submit(600);
    expect(invoke).toHaveBeenCalledWith("twitch_timeout_user", {
      channelId: "chan",
      targetUserId: "7",
      durationSeconds: 600,
      reason: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Warn" }));
    const warn = modPopover();
    if (warn?.kind !== "warn") throw new Error("no warn box");
    warn.submit("no spoilers");
    expect(invoke).toHaveBeenCalledWith("twitch_warn_user", {
      channelId: "chan",
      targetUserId: "7",
      reason: "no spoilers",
    });
  });

  it("opens both from the right-click menu at the pointer", async () => {
    role.mod = true;
    const { container } = renderFeed("me");
    await tick();
    emit("chat_messages", [msg("menu")]);
    await tick();
    const pick = (label: string) => {
      fireEvent.contextMenu(rowFor(container, "menu"), {
        clientX: 40,
        clientY: 50,
      });
      const entry = contextMenu()?.items.find(
        (i) => i.kind === "item" && i.label === label,
      );
      if (entry?.kind !== "item") throw new Error(`no ${label}`);
      closeContextMenu();
      entry.onSelect();
    };
    pick("Custom timeout…");
    expect(modPopover()).toMatchObject({ kind: "timeout", x: 40, y: 50 });
    pick("Warn…");
    expect(modPopover()).toMatchObject({ kind: "warn", x: 40, y: 50 });
  });

  it("remembers the user's own badges from live chat", async () => {
    setAuthStatus({
      state: "logged_in",
      login: "viewer",
      user_id: "7",
      missing_scopes: [],
      enabled_scope_groups: [],
    });
    renderFeed("viewer");
    await tick();
    emit("chat_messages", [
      { ...msg("mine"), badges: [{ set_id: "subscriber", id: "6" }] },
    ]);
    await tick();
    expect(ownBadges("chan")).toEqual([{ set_id: "subscriber", id: "6" }]);
    setAuthStatus(null);
  });

  it("jumps to a loaded message and flashes it", async () => {
    const { container } = renderFeed("me");
    await tick();
    emit("chat_messages", [msg("old"), msg("new")]);
    await tick();
    jumpToMessage("chan", "old");
    await tick();
    expect(rowFor(container, "old").classList).toContain("msg--jumped");
    expect(jumpRequest()).toBeNull();
  });

  it("says when the message is gone, and opens another channel first", async () => {
    renderFeed("me");
    await tick();
    jumpToMessage("chan", "missing");
    await tick();
    expect(notice()).toBe("That message is no longer in the loaded chat");

    jumpToMessage("elsewhere", "m1");
    await tick();
    expect(focusChannel).toHaveBeenCalledWith("elsewhere");
    expect(jumpRequest()).not.toBeNull();
  });

  it("opens a card window for the name clicked", async () => {
    const { container } = renderFeed("me");
    await tick();
    emit("chat_messages", [msg("hi")]);
    await tick();
    fireEvent.click(rowFor(container, "hi").querySelector(".msg__user")!);
    expect(invoke).toHaveBeenCalledWith("user_card_open", {
      user: {
        channel_id: "chan",
        platform_user_id: "7",
        username: "viewer",
        display_name: "Viewer",
        color: null,
        badges: [],
      },
      zoom: 1,
    });
  });

  it("hides the mod buttons from viewers", async () => {
    renderFeed("me");
    await tick();
    emit("chat_messages", [msg("calm")]);
    await tick();
    expect(screen.queryByRole("button", { name: "Warn" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Timeout" })).toBeNull();
  });

  it("marks a row whether the flag lands before or after it", async () => {
    const { container } = renderFeed("me");
    await tick();

    emit("chat_messages", [msg("late"), msg("plain")]);
    emit("first_message", { channel_id: "chan", message_id: "early" });
    emit("chat_messages", [msg("early")]);
    await tick();
    expect(rowFor(container, "late").classList).not.toContain("msg--first");
    expect(rowFor(container, "early").classList).toContain("msg--first");
    expect(rowFor(container, "early").textContent).toContain("First message");

    emit("first_message", { channel_id: "chan", message_id: "late" });
    await tick();
    expect(rowFor(container, "late").classList).toContain("msg--first");
    expect(rowFor(container, "plain").classList).not.toContain("msg--first");
  });

  it("marks rows that carry the saved flag", async () => {
    const { container } = renderFeed("me");
    await tick();

    emit("chat_messages", [{ ...msg("saved"), first_message: true }]);
    await tick();
    expect(rowFor(container, "saved").classList).toContain("msg--first");
  });

  it("hides the mark while the setting is off", async () => {
    const { container } = renderFeed("me");
    await tick();

    emit("first_message", { channel_id: "chan", message_id: "off" });
    emit("chat_messages", [msg("off")]);
    await tick();
    expect(rowFor(container, "off").classList).toContain("msg--first");

    await updateSettings({ highlightFirstMessages: false });
    await tick();
    expect(rowFor(container, "off").classList).not.toContain("msg--first");
  });

  it("gilds raids and gift bombs but not other notices", async () => {
    const { container } = renderFeed("me");
    await tick();

    const noticed = (id: string, notice_type: string) => ({
      ...msg(id),
      notice: { notice_type, system_message: "" },
    });
    emit("chat_messages", [
      noticed("raid", "raid"),
      noticed("bomb", "shared_chat_community_sub_gift"),
      noticed("resub", "resub"),
      msg("chat"),
    ]);
    await tick();
    expect(rowFor(container, "raid").classList).toContain("msg--celebration");
    expect(rowFor(container, "bomb").classList).toContain("msg--celebration");
    expect(rowFor(container, "resub").classList).not.toContain(
      "msg--celebration",
    );
    expect(rowFor(container, "chat").classList).not.toContain(
      "msg--celebration",
    );
  });
});
