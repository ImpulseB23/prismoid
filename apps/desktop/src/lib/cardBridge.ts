// Messages between the main window and user card windows. A card is its
// own webview without the chat box, the feed or the mod log, so it hands
// mentions and jumps to the main window and asks it for the mod log.

import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ModAction } from "./chatEvents";
import type { JumpRequest } from "../stores/jumpStore";

const MAIN = "main";
const MENTION = "card_mention";
const JUMP = "card_jump";
const MOD_LOG_REQUEST = "card_mod_log_request";
const MOD_LOG = "card_mod_log";
const MOD_LOG_CHANGED = "card_mod_log_changed";

interface ModLogRequest {
  user_id: string;
  /** Label of the card window that asked. */
  reply_to: string;
}

const report = (what: string) => (err: unknown) => console.error(what, err);

/* Card side */

export function sendMention(login: string): void {
  void emitTo(MAIN, MENTION, login).catch(report("card mention"));
}

export function sendJump(channelId: string, messageId: string): void {
  const jump: JumpRequest = { channel_id: channelId, message_id: messageId };
  void emitTo(MAIN, JUMP, jump).catch(report("card jump"));
}

/** Asks the main window for `userId`'s mod log, now and whenever it grows. */
export async function followModLog(
  userId: string,
  onLog: (actions: ModAction[]) => void,
): Promise<UnlistenFn> {
  const card = getCurrentWebviewWindow();
  const ask = () => {
    const request: ModLogRequest = { user_id: userId, reply_to: card.label };
    void emitTo(MAIN, MOD_LOG_REQUEST, request).catch(report("card mod log"));
  };
  const offs = await Promise.all([
    card.listen<ModAction[]>(MOD_LOG, (e) => onLog(e.payload)),
    listen(MOD_LOG_CHANGED, ask),
  ]);
  ask();
  return () => {
    for (const off of offs) off();
  };
}

/* Main window side */

export interface CardServer {
  mention: (login: string) => void;
  jump: (jump: JumpRequest) => void;
  modLogFor: (userId: string) => ModAction[];
}

/** Answers card windows; returns the stop function. */
export async function serveCards(server: CardServer): Promise<UnlistenFn> {
  const bringForward = () =>
    void invoke("show_main_window").catch(report("show main window"));
  const offs = await Promise.all([
    listen<string>(MENTION, (e) => {
      server.mention(e.payload);
      bringForward();
    }),
    listen<JumpRequest>(JUMP, (e) => {
      server.jump(e.payload);
      bringForward();
    }),
    listen<ModLogRequest>(MOD_LOG_REQUEST, (e) => {
      void emitTo(
        e.payload.reply_to,
        MOD_LOG,
        server.modLogFor(e.payload.user_id),
      ).catch(report("answer card mod log"));
    }),
  ]);
  return () => {
    for (const off of offs) off();
  };
}

/** Tells open cards the mod log changed, so they ask again. */
export function announceModLog(): void {
  void emit(MOD_LOG_CHANGED).catch(report("announce mod log"));
}
