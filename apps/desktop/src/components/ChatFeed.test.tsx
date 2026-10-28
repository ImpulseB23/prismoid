import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
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
// module, here only the chip flag matters.
vi.mock("../lib/messageLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/messageLayout")>()),
  prepareMessage: (
    msg: ChatMessage,
    _resolve: unknown,
    opts: { firstMessage?: boolean; metrics?: TextMetrics },
  ): Partial<PreparedMessage> => ({
    pieces: [{ kind: "text", text: msg.message_text }],
    badges: [],
    timestamp: "",
    replyParent: null,
    notice: null,
    firstMessage: opts.firstMessage === true,
    metrics: opts.metrics,
  }),
  measureMessageHeight: () => 26,
}));

const { clearMessages } = await import("../stores/chatStore");
const { updateSettings } = await import("../stores/settingsStore");
const { default: ChatFeed } = await import("./ChatFeed");

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

describe("ChatFeed first messages", () => {
  beforeEach(() => {
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
    cleanup();
    clearMessages();
    handlers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await updateSettings({ highlightFirstMessages: true });
  });

  it("marks a row whether the flag lands before or after it", async () => {
    const { container } = render(() => <ChatFeed login="me" />);
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
    expect(rowFor(container, "plain").textContent).not.toContain(
      "First message",
    );
  });

  it("marks rows that carry the saved flag", async () => {
    const { container } = render(() => <ChatFeed login="me" />);
    await tick();

    emit("chat_messages", [{ ...msg("saved"), first_message: true }]);
    await tick();
    expect(rowFor(container, "saved").classList).toContain("msg--first");
  });

  it("hides the mark while the setting is off", async () => {
    const { container } = render(() => <ChatFeed login="me" />);
    await tick();

    emit("first_message", { channel_id: "chan", message_id: "off" });
    emit("chat_messages", [msg("off")]);
    await tick();
    expect(rowFor(container, "off").classList).toContain("msg--first");

    await updateSettings({ highlightFirstMessages: false });
    await tick();
    expect(rowFor(container, "off").classList).not.toContain("msg--first");
  });
});
