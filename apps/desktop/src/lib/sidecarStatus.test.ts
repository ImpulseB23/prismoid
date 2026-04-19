import { describe, expect, it } from "vitest";
import { indicatorFor } from "./sidecarStatus";

describe("indicatorFor", () => {
  it("running → green connected", () => {
    const i = indicatorFor("running");
    expect(i.label).toBe("Connected");
    expect(i.color).toBe("#3fb950");
  });

  it("spawning and backoff share the connecting label", () => {
    expect(indicatorFor("spawning").label).toBe("Connecting");
    expect(indicatorFor("backoff").label).toBe("Connecting");
  });

  it("waiting_for_auth surfaces a sign-in hint", () => {
    expect(indicatorFor("waiting_for_auth").label).toBe("Waiting for sign-in");
  });

  it("unhealthy and terminated are distinct", () => {
    expect(indicatorFor("unhealthy").label).toBe("Unhealthy");
    expect(indicatorFor("terminated").label).toBe("Disconnected");
  });

  it("null before any event reports a starting state", () => {
    expect(indicatorFor(null).label).toBe("Starting");
  });
});
