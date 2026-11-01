// Patch notes the app shows once after it updates, and again from
// Settings. Written for the people using Prismoid, in plain words; the
// GitHub changelog keeps the commit-level list.

import { compareVersions } from "./lib/version";

export interface ReleaseNote {
  version: string;
  headline: string;
  /** New, as a title and a sentence or two each. */
  features: { title: string; body: string }[];
  /** Improved, one line each. */
  improvements: string[];
  /** Fixed, one line each. */
  fixes: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.10.0",
    headline: "Surf streams without the tab pile",
    features: [
      {
        title: "Preview tabs",
        body: "With Follow my browser on, a stream you open in the browser shows up as a tab in italics. Click through ten streams and it stays one tab that follows along. Type in it, double-click it or stay on it a couple of minutes and it becomes a regular tab.",
      },
    ],
    improvements: [
      "What's New is sorted into new, improved and fixed.",
      "Only channels you keep end up in your recents.",
    ],
    fixes: [],
  },
  {
    version: "0.9.3",
    headline: "Updates that always land",
    features: [],
    improvements: [],
    fixes: [
      "If an update can't finish, Prismoid says so and opens again on its own instead of disappearing.",
    ],
  },
  {
    version: "0.9.2",
    headline: "Bans and timeouts, spelled out",
    features: [
      {
        title: "Ban or timeout, and for how long",
        body: "When someone gets removed from chat, the line now says whether they were banned or timed out and for how long. Bans show in red, timeouts in orange.",
      },
    ],
    improvements: [
      "A small Prismoid window stays up while an update installs, so the app no longer just vanishes for a few seconds.",
    ],
    fixes: [],
  },
  {
    version: "0.9.0",
    headline: "Chats side by side, the stream right there",
    features: [
      {
        title: "Split view",
        body: "Put up to four chats next to each other. Drag a tab onto a pane or the right edge, or use the split button. Drag a pane by its header to swap it with another.",
      },
      {
        title: "Watch while you chat",
        body: "The video button shows the stream small in the corner of the chat, and it keeps playing when you switch tabs. Pop it out into its own window to resize it, pin it on top or go fullscreen.",
      },
      {
        title: "A gear for your chat",
        body: "Next to the emote button: pick your name color, see how you look in chat, pause chat on hover or while holding Alt, freeze animated emotes, and turn readable colors and timestamps on or off.",
      },
      {
        title: "Keep only what you use",
        body: "Settings has a Features page. Switch off split view, stream video, the stream manager, mod tools or 7TV and they are gone, background work included. Settings itself now lives under your picture.",
      },
      {
        title: "More at a glance",
        body: "Hover a badge to see it large with its name, or a name to see who it is and how old the account is. Drag tabs to put them in any order.",
      },
    ],
    improvements: [],
    fixes: [
      "Slow mode counts down in every channel, not only where you mod, so messages no longer get turned away for being too early.",
      "When Twitch briefly refuses a message, Prismoid tries again on its own, and errors read like sentences.",
      "Right-click menus and emote cards stay open in fast chat.",
      "Chat you scrolled up in stays perfectly still.",
      "User cards follow your zoom, keep one size, and show subs and timeouts instead of empty rows.",
      "The pop-out keeps the stream's shape when you resize it.",
    ],
  },
  {
    version: "0.8.5",
    headline: "Cards in their own windows",
    features: [
      {
        title: "User cards you can keep open",
        body: "Clicking a name opens their card in its own window at your mouse. Pin it to keep it around while you click more names, or let it close when you click away.",
      },
      {
        title: "Everything they said, right there",
        body: "A card shows their recent messages in one tight list and keeps it live. Click one to jump to it in chat, or Mention them straight from the card.",
      },
      {
        title: "Sending feels instant",
        body: "Your message shows up with your name color, badges and emotes the moment you press Enter, instead of catching up a second later.",
      },
    ],
    improvements: [],
    fixes: [
      "Mentions marks only the ones you have not seen, with a thin line under the message.",
      "Cards follow your zoom and chat text size.",
    ],
  },
  {
    version: "0.8.3",
    headline: "Quicker to moderate, easier to find",
    features: [
      {
        title: "Warn and pick a timeout",
        body: "Hover a message for a clock that opens your timeout lengths or a custom one, and a warn button that asks for the reason they will read. Both are in the right-click menu too. Mods reconnect Twitch once to warn.",
      },
      {
        title: "Updates wait for you",
        body: "New versions download while you chat. A gold download icon shows up next to Settings when one is ready, and a click restarts you into it.",
      },
      {
        title: "Settings, sorted",
        body: "Appearance is only about looks now. Mentions, highlights and ignored people have their own section, and the stream bar stats moved to Chat.",
      },
      {
        title: "Hear your mentions",
        body: "Play the mention chime from Settings, set its volume, and have it ring even while Prismoid is in front.",
      },
    ],
    improvements: [],
    fixes: [
      "When Settings has a dot, the section and the setting it means are marked too.",
      "Raids and gift bombs get a gold edge in chat.",
    ],
  },
  {
    version: "0.8.0",
    headline: "Run your stream from your chat",
    features: [
      {
        title: "Stream manager",
        body: "The broadcast button in the header drops your stream controls over the chat: title, category, tags, language and content labels. Your chat keeps running underneath.",
      },
      {
        title: "Your stream at a glance",
        body: "Uptime and viewers up top, and a timeline of the stream so far with ad breaks, markers and polls right where they happened.",
      },
      {
        title: "Quick actions",
        body: "Add a marker, clip what just happened, shout someone out, send an announcement or switch on Shield Mode in one tap.",
      },
      {
        title: "Ads, polls and predictions",
        body: "See when the next ad comes, snooze it or run one when it suits you. Start polls and predictions and watch the results live. These are for Twitch Affiliates and Partners.",
      },
      {
        title: "Chat manager",
        body: "The tab on the right edge of the chat is now the chat manager. Tap room modes on and off, with the AutoMod queue and mod log in tabs.",
      },
      {
        title: "Only asks when you need it",
        body: "Prismoid asks Twitch for stream permissions only when you turn a part of the stream manager on, so viewers and mods never see the prompt.",
      },
    ],
    improvements: [],
    fixes: [
      "Settings no longer slips under the window buttons in fullscreen.",
      "Chat modes no longer get stuck on Loading after switching channels.",
      "Opening a channel says whose chat it is.",
    ],
  },
  {
    version: "0.7.0",
    headline: "A fresh coat of prism",
    features: [
      {
        title: "A new look",
        body: "Prismoid has its own title bar and window buttons now, a deeper purple and a bigger window that follows your display scale.",
      },
      {
        title: "Command center",
        body: "Chat modes, the AutoMod queue and the mod log live together in one panel. Clear chat sits at the bottom and asks twice.",
      },
      {
        title: "Chat pulse",
        body: "The stream bar shows messages per minute and how many people are chatting, counted for every open tab. Turn each stat on or off in Settings.",
      },
      {
        title: "Followed channels that are live",
        body: "The channel picker lists the people you follow who are live right now, with the ones you opened recently on top. Prismoid asks you to reconnect Twitch once to turn it on.",
      },
      {
        title: "Emotes up close",
        body: "Hover an emote to see its name, where it comes from and who made it. Click it for a bigger card that shows who added it. The emote picker got a rail to jump between sets.",
      },
      {
        title: "Fullscreen that gets out of the way",
        body: "In fullscreen the header slides away when your mouse leaves it and comes back when you move to the top.",
      },
      {
        title: "Settings, all in one place",
        body: "Settings opens as a full page with sections. Copy logs, reset or uninstall from Troubleshooting when something goes wrong.",
      },
    ],
    improvements: [],
    fixes: [
      "Right-click menus that fit the app, everywhere it makes sense.",
      "Mods can delete their own messages, and a More button on each message holds the rest.",
      "Search, mentions, threads and user cards share one cleaner popup style, and they wait for their data before opening.",
      "Mentions now come from chat history across all your tabs.",
      "The tab underline slides between tabs, and header icons react when you click them.",
      "First message tags stay put after a reload and sit to the right of the message.",
      "The setup tour walks you through Settings too.",
      "Versions like 0.7.0 show as 0.7.",
    ],
  },
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
    improvements: [],
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

/**
 * The newest notes released after `from`, up to and including `to`, so an
 * update that skips a release with notes still shows them.
 */
export function notesSince(from: string, to: string): ReleaseNote | undefined {
  return RELEASE_NOTES.filter(
    (n) =>
      compareVersions(n.version, from) > 0 &&
      compareVersions(n.version, to) <= 0,
  ).sort((a, b) => compareVersions(b.version, a.version))[0];
}
