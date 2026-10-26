// Parses moderation commands typed into the composer, the same ones the
// Twitch web chat and Chatterino accept. Anything else starting with "/"
// is an error rather than a message, so a typo never gets sent to chat.

export type SlashCommand =
  | { kind: "ban"; login: string; reason?: string }
  | { kind: "unban"; login: string }
  | { kind: "timeout"; login: string; seconds: number; reason?: string }
  | { kind: "me"; text: string };

export type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "command"; command: SlashCommand }
  | { kind: "error"; message: string };

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1_209_600;
const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

export const SLASH_COMMAND_HELP = [
  "/ban <user> [reason]",
  "/unban <user>",
  "/timeout <user> [duration] [reason]",
  "/me <text>",
];

/** "600", "10m", "1h30m", "2d" to seconds; null when malformed. */
export function parseDuration(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  let total = 0;
  let matched = false;
  for (const m of raw.matchAll(/(\d+)([smhdw])/g)) {
    matched = true;
    total += Number(m[1]) * UNIT_SECONDS[m[2]!]!;
  }
  const consumed = raw.replace(/(\d+)([smhdw])/g, "");
  return matched && consumed === "" ? total : null;
}

/** Seconds to the shortest "1d 2h 3m 4s" form, for status lines. */
export function formatSeconds(total: number): string {
  const parts: string[] = [];
  let rest = total;
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${unit}`);
      rest -= n * size;
    }
  }
  if (rest > 0 || parts.length === 0) parts.push(`${rest}s`);
  return parts.join(" ");
}

function login(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(s) ? s : null;
}

export function parseInput(text: string): ParsedInput {
  if (!text.startsWith("/") || text.startsWith("//")) {
    return { kind: "message", text };
  }
  const [name = "", ...rest] = text.slice(1).split(/\s+/);
  const cmd = name.toLowerCase();
  switch (cmd) {
    case "me": {
      const body = rest.join(" ").trim();
      if (!body) return { kind: "error", message: "Usage: /me <text>" };
      return { kind: "command", command: { kind: "me", text: body } };
    }
    case "ban": {
      const user = login(rest[0]);
      if (!user)
        return { kind: "error", message: "Usage: /ban <user> [reason]" };
      const reason = rest.slice(1).join(" ").trim() || undefined;
      return { kind: "command", command: { kind: "ban", login: user, reason } };
    }
    case "unban": {
      const user = login(rest[0]);
      if (!user) return { kind: "error", message: "Usage: /unban <user>" };
      return { kind: "command", command: { kind: "unban", login: user } };
    }
    case "timeout": {
      const user = login(rest[0]);
      if (!user) {
        return {
          kind: "error",
          message: "Usage: /timeout <user> [duration] [reason]",
        };
      }
      let seconds = DEFAULT_TIMEOUT_SECONDS;
      let reasonParts = rest.slice(1);
      if (rest[1] !== undefined) {
        const parsed = parseDuration(rest[1]);
        if (parsed !== null) {
          seconds = parsed;
          reasonParts = rest.slice(2);
        }
      }
      if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
        return {
          kind: "error",
          message: "Timeout must be between 1 second and 2 weeks.",
        };
      }
      const reason = reasonParts.join(" ").trim() || undefined;
      return {
        kind: "command",
        command: { kind: "timeout", login: user, seconds, reason },
      };
    }
    default:
      return {
        kind: "error",
        message: `Unknown command /${cmd}. Try ${SLASH_COMMAND_HELP.join(", ")}.`,
      };
  }
}
