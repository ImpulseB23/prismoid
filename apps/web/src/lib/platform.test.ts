import { describe, expect, it } from "vitest";
import { detectPlatform, fromUserAgent } from "./platform";

const UA = {
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linuxFirefox:
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
};

describe("fromUserAgent", () => {
  it("tells the platforms apart despite shared tokens", () => {
    expect(fromUserAgent(UA.windowsChrome)).toBe("windows");
    expect(fromUserAgent(UA.macSafari)).toBe("macos");
    expect(fromUserAgent(UA.linuxFirefox)).toBe("linux");
    expect(fromUserAgent(UA.chromebook)).toBe("chromeos");
    expect(fromUserAgent(UA.iphone)).toBe("ios");
    expect(fromUserAgent(UA.ipad)).toBe("ios");
    expect(fromUserAgent(UA.android)).toBe("android");
  });

  it("gives up on agents it does not recognise", () => {
    expect(fromUserAgent("curl/8.7.1")).toBe("unknown");
    expect(fromUserAgent("")).toBe("unknown");
  });
});

describe("detectPlatform", () => {
  it("prefers the client hint over the user agent", () => {
    const headers = new Headers({
      "sec-ch-ua-platform": '"macOS"',
      "user-agent": UA.windowsChrome,
    });
    expect(detectPlatform(headers)).toBe("macos");
  });

  it("maps every spec value of the hint", () => {
    const cases: [string, string][] = [
      ['"Windows"', "windows"],
      ['"Linux"', "linux"],
      ['"Chrome OS"', "chromeos"],
      ['"Chromium OS"', "chromeos"],
      ['"Android"', "android"],
      ['"iOS"', "ios"],
    ];
    for (const [hint, platform] of cases) {
      expect(detectPlatform(new Headers({ "sec-ch-ua-platform": hint }))).toBe(
        platform,
      );
    }
  });

  it("falls back to the user agent when the hint is missing or unknown", () => {
    expect(detectPlatform(new Headers({ "user-agent": UA.macSafari }))).toBe(
      "macos",
    );
    const unknownHint = new Headers({
      "sec-ch-ua-platform": '"Unknown"',
      "user-agent": UA.linuxFirefox,
    });
    expect(detectPlatform(unknownHint)).toBe("linux");
    expect(detectPlatform(new Headers())).toBe("unknown");
  });
});
