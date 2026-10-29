import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModAction } from "./chatEvents";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
const cardHandlers = new Map<string, Handler>();
const sent: [string, string, unknown][] = [];
const broadcast: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (event: string) => {
    broadcast.push(event);
  }),
  emitTo: vi.fn(async (target: string, event: string, payload: unknown) => {
    sent.push([target, event, payload]);
  }),
  listen: vi.fn(async (event: string, cb: Handler) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "user-card-1",
    listen: async (event: string, cb: Handler) => {
      cardHandlers.set(event, cb);
      return () => cardHandlers.delete(event);
    },
  }),
}));
const invoke = vi.fn(async () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const bridge = await import("./cardBridge");

const action = { kind: "mod_action", action: "ban" } as ModAction;

describe("cardBridge", () => {
  beforeEach(() => {
    handlers.clear();
    cardHandlers.clear();
    sent.length = 0;
    broadcast.length = 0;
    invoke.mockClear();
  });

  it("sends mentions and jumps to the main window", () => {
    bridge.sendMention("kit");
    bridge.sendJump("c", "m");
    expect(sent).toEqual([
      ["main", "card_mention", "kit"],
      ["main", "card_jump", { channel_id: "c", message_id: "m" }],
    ]);
  });

  it("asks for the mod log now and again when it changes", async () => {
    const onLog = vi.fn();
    const stop = await bridge.followModLog("u1", onLog);
    expect(sent).toEqual([
      [
        "main",
        "card_mod_log_request",
        { user_id: "u1", reply_to: "user-card-1" },
      ],
    ]);
    cardHandlers.get("card_mod_log")!({ payload: [action] });
    expect(onLog).toHaveBeenCalledWith([action]);
    handlers.get("card_mod_log_changed")!({ payload: null });
    expect(sent).toHaveLength(2);
    stop();
    expect(cardHandlers.size).toBe(0);
  });

  it("serves cards from the main window and brings it forward", async () => {
    const server = {
      mention: vi.fn(),
      jump: vi.fn(),
      modLogFor: vi.fn(() => [action]),
    };
    const stop = await bridge.serveCards(server);
    handlers.get("card_mention")!({ payload: "kit" });
    handlers.get("card_jump")!({
      payload: { channel_id: "c", message_id: "m" },
    });
    handlers.get("card_mod_log_request")!({
      payload: { user_id: "u1", reply_to: "user-card-1" },
    });
    expect(server.mention).toHaveBeenCalledWith("kit");
    expect(server.jump).toHaveBeenCalledWith({
      channel_id: "c",
      message_id: "m",
    });
    expect(invoke).toHaveBeenCalledWith("show_main_window");
    expect(sent).toEqual([["user-card-1", "card_mod_log", [action]]]);
    bridge.announceModLog();
    expect(broadcast).toEqual(["card_mod_log_changed"]);
    stop();
    expect(handlers.size).toBe(0);
  });
});
