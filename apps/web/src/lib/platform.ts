// Works out which operating system a visitor is on so the landing page can
// offer the right installer, or say plainly that there is none yet. Chromium
// browsers send the platform as a low-entropy client hint on every request;
// Safari and Firefox only send a user agent, so that is the fallback.

export type Platform =
  "windows" | "macos" | "linux" | "chromeos" | "ios" | "android" | "unknown";

export const RELEASES = "https://github.com/ImpulseB23/Prismoid/releases";

// Only platforms the release workflow actually uploads an installer for.
export const INSTALLERS: Partial<Record<Platform, string>> = {
  windows: `${RELEASES}/latest/download/Prismoid-Setup-x64.exe`,
};

export const PLATFORM_NAMES: Record<Platform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  chromeos: "ChromeOS",
  ios: "iOS",
  android: "Android",
  unknown: "your device",
};

export function detectPlatform(headers: Headers): Platform {
  const hint = headers.get("sec-ch-ua-platform");
  if (hint) {
    const platform = fromClientHint(hint.replace(/"/g, ""));
    if (platform !== "unknown") return platform;
  }
  return fromUserAgent(headers.get("user-agent") ?? "");
}

// Values are fixed by the UA client hints spec.
function fromClientHint(value: string): Platform {
  switch (value) {
    case "Windows":
      return "windows";
    case "macOS":
      return "macos";
    case "Linux":
      return "linux";
    case "Chrome OS":
    case "Chromium OS":
      return "chromeos";
    case "Android":
      return "android";
    case "iOS":
      return "ios";
    default:
      return "unknown";
  }
}

// Order matters: iOS agents mention Mac OS X, Android and ChromeOS agents
// mention Linux.
export function fromUserAgent(ua: string): Platform {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux|X11/.test(ua)) return "linux";
  return "unknown";
}
