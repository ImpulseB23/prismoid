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
    headline: "Make it yours",
    features: [
      {
        title: "Themes",
        body: "Dark, Midnight for pure black screens, Light, or follow Windows. Settings, Appearance.",
      },
      {
        title: "Chat text size",
        body: "Ctrl + and Ctrl − (or Ctrl + scroll) now size just the chat. Zoom for the whole window moved to Settings.",
      },
      {
        title: "Search chat",
        body: "Ctrl + F finds any message. Try from:name or has:link.",
      },
      {
        title: "Clear chat",
        body: "Mods get a Clear button on the mod bar. Tap twice to wipe the room.",
      },
      {
        title: "Know when you're mentioned",
        body: "A soft chime and a taskbar flash when someone says your name while you're looking elsewhere.",
      },
      {
        title: "Reply and copy",
        body: "Hover any message for quick Reply and Copy buttons.",
      },
    ],
    fixes: [
      "Messages that mention you now stand out on user cards too.",
      "Timestamps start off for new installs. Turn them on in Settings.",
      "Updates show up within minutes instead of hours.",
      "Sign-in problems now say what went wrong and give you a link to copy.",
    ],
  },
];

export function notesFor(version: string): ReleaseNote | undefined {
  return RELEASE_NOTES.find((n) => n.version === version);
}
