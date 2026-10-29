import { afterEach, describe, expect, it } from "vitest";
import type { ScopeGroup } from "../lib/twitchAuth";
import {
  scopeGroupEnabled,
  scopeGroupNeedsReconnect,
  scopeGroupReady,
  setAuthStatus,
} from "./authStore";

const signedIn = (enabled: ScopeGroup[], missing: string[]) =>
  setAuthStatus({
    state: "logged_in",
    login: "me",
    user_id: "1",
    missing_scopes: missing,
    enabled_scope_groups: enabled,
  });

afterEach(() => setAuthStatus(null));

describe("scope groups", () => {
  it("reports enabled groups only while signed in", () => {
    expect(scopeGroupEnabled("ads")).toBe(false);
    setAuthStatus({ state: "logged_out" });
    expect(scopeGroupEnabled("ads")).toBe(false);
    signedIn(["ads"], []);
    expect(scopeGroupEnabled("ads")).toBe(true);
    expect(scopeGroupEnabled("live_actions")).toBe(false);
  });

  it("needs a reconnect when an enabled group misses a scope", () => {
    signedIn(["live_actions"], ["clips:edit"]);
    expect(scopeGroupNeedsReconnect("live_actions")).toBe(true);
    signedIn(["live_actions"], ["channel:manage:ads"]);
    expect(scopeGroupNeedsReconnect("live_actions")).toBe(false);
  });

  it("never asks a reconnect for a group that is off", () => {
    signedIn([], ["channel:read:ads"]);
    expect(scopeGroupNeedsReconnect("ads")).toBe(false);
  });

  it("is ready only when on and granted", () => {
    signedIn([], []);
    expect(scopeGroupReady("ads")).toBe(false);
    signedIn(["ads"], ["channel:read:ads"]);
    expect(scopeGroupReady("ads")).toBe(false);
    signedIn(["ads"], []);
    expect(scopeGroupReady("ads")).toBe(true);
  });
});
