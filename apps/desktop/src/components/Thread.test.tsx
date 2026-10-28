import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ChatMessage } from "../stores/chatStore";

const msg = (id: string, text: string, thread: string | null): ChatMessage =>
  ({
    id,
    username: `u${id}`,
    display_name: `User${id}`,
    color: null,
    timestamp: 0,
    message_text: text,
    emote_spans: [],
    reply_to: thread,
    reply_parent: thread
      ? { user_login: "op", user_name: "Op", body: "hot take", thread_id: "" }
      : null,
  }) as unknown as ChatMessage;

const loaded: ChatMessage[] = [];
vi.mock("../stores/chatStore", () => ({
  messageRevision: () => 0,
  findMessageById: (id: string) => loaded.find((m) => m.id === id),
  searchMessages: (match: (m: ChatMessage) => boolean) =>
    loaded.filter(match).reverse(),
}));
const reply = vi.fn();
vi.mock("../stores/composerStore", () => ({
  requestReply: (t: unknown) => reply(t),
}));

const { openThread, threadRoot, threadRootOf } =
  await import("../stores/threadStore");
const { default: Thread } = await import("./Thread");

describe("threadRootOf", () => {
  it("prefers the thread id and falls back to the parent", () => {
    const a = msg("a", "x", "p");
    expect(threadRootOf(a)).toBe("p");
    a.reply_parent!.thread_id = "root";
    expect(threadRootOf(a)).toBe("root");
    expect(threadRootOf(msg("b", "x", null))).toBeNull();
  });
});

describe("Thread", () => {
  afterEach(() => {
    cleanup();
    loaded.length = 0;
  });

  it("shows the origin and replies oldest first, and replies to the last", () => {
    loaded.push(msg("root", "hot take", null));
    loaded.push(msg("r1", "agree", "root"), msg("r2", "nah", "root"));
    loaded.push(msg("x", "unrelated", null));
    render(() => <Thread />);
    openThread(loaded[1]!);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("hot take"),
      expect.stringContaining("agree"),
      expect.stringContaining("nah"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Reply to thread" }));
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: "r2" }),
    );
    expect(threadRoot()).toBeNull();
  });

  it("quotes the original when it is no longer loaded", () => {
    loaded.push(msg("r1", "agree", "gone"));
    render(() => <Thread />);
    openThread(loaded[0]!);
    expect(screen.getAllByRole("listitem")[0]!.textContent).toContain(
      "hot take",
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(threadRoot()).toBeNull();
  });
});
