import { describe, expect, it } from "vitest";
import { DEEP_LINK, deepLinkFor } from "./twitchDeepLink";

describe("deepLinkFor", () => {
  it("forwards a granted token from the fragment", () => {
    const link = deepLinkFor(
      "#access_token=tok%2B1&scope=user%3Aread%3Achat+user%3Awrite%3Achat&state=abc&token_type=bearer&junk=1",
      "",
    );
    expect(link).not.toBeNull();
    const url = new URL(link!);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(DEEP_LINK);
    expect(url.searchParams.get("access_token")).toBe("tok+1");
    expect(url.searchParams.get("scope")).toBe(
      "user:read:chat user:write:chat",
    );
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("token_type")).toBe("bearer");
    expect(url.searchParams.has("junk")).toBe(false);
  });

  it("forwards a refusal from the query", () => {
    const link = deepLinkFor(
      "",
      "?error=access_denied&error_description=The+user+denied+you+access&state=abc",
    );
    const url = new URL(link!);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("error_description")).toBe(
      "The user denied you access",
    );
    expect(url.searchParams.get("state")).toBe("abc");
  });

  it("returns nothing when Twitch sent nothing", () => {
    expect(deepLinkFor("", "")).toBeNull();
    expect(deepLinkFor("#foo=bar", "?utm_source=x")).toBeNull();
  });
});
