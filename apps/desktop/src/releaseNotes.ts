// Patch notes the app shows once after it updates, and again from
// Settings. Written for the people using Prismoid, in plain words; the
// GitHub changelog keeps the commit-level list.

export interface ReleaseNote {
  version: string;
  headline: string;
  features: { title: string; body: string }[];
  fixes: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.6.0",
    headline: "Your chat, run your way",
    features: [
      {
        title: "AutoMod queue",
        body: "Messages AutoMod holds land in a queue on the mod bar. Allow or deny them with one tap. Prismoid asks you to reconnect Twitch once to turn it on.",
      },
      {
        title: "First-time chatters",
        body: "Someone's very first message in a channel gets a First message tag, so you can say hi.",
      },
      {
        title: "Mentions",
        body: "The @ button collects every message that names you, from every open channel. Tap one to jump there.",
      },
      {
        title: "Reply threads",
        body: "Click the quote on any reply to see the whole conversation, start to finish.",
      },
      {
        title: "Highlight people and badges",
        body: "Make your co-host, your mods or your VIPs stand out. Settings, Chat, or Highlight on anyone's card.",
      },
      {
        title: "Themes and 7TV paints",
        body: "Dark, Midnight for pure black screens, Light, or follow Windows. Names wear their 7TV paints too.",
      },
      {
        title: "Chat text size",
        body: "Ctrl + and Ctrl − (or Ctrl + scroll) now size just the chat. Zoom for the whole window lives in Settings.",
      },
      {
        title: "Search and clear",
        body: "Ctrl + F finds any message (try from:name or has:link). Mods can wipe the room from the mod bar.",
      },
      {
        title: "Lives in your tray",
        body: "Start Prismoid with Windows and let the X tuck it into the tray instead of closing it.",
      },
    ],
    fixes: [
      "A soft chime and a taskbar flash when someone says your name while you're looking elsewhere.",
      "Hover any message for quick Reply and Copy buttons.",
      "Alternating row shading for busy chats, in Settings.",
      "Messages that mention you now stand out on user cards too.",
      "Timestamps start off for new installs. Turn them on in Settings.",
      "Updates show up within minutes instead of hours.",
      "Reconnecting Twitch takes effect right away, no restart needed.",
      "Sign-in problems now say what went wrong and give you a link to copy.",
    ],
  },
];

export function notesFor(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version);
}
