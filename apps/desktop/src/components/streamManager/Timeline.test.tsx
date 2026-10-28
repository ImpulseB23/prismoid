import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { AdBreak } from "../../lib/ads";
import type { LogEntry } from "../../stores/streamLogStore";
import Timeline from "./Timeline";

const START = Date.UTC(2026, 9, 28, 20, 0);
const MIN = 60_000;

const ad: AdBreak = {
  channel_id: "7",
  duration_seconds: 180,
  started_at: START + 20 * MIN,
  is_automatic: false,
  requester_id: "7",
  requester_login: "me",
  requester_name: "Me",
};

const entries: LogEntry[] = [
  { kind: "ad", id: "a", at: ad.started_at, ad },
  {
    kind: "marker",
    id: "m",
    at: START + 50 * MIN,
    marker: {
      id: "m",
      created_at: START + 50 * MIN,
      position_seconds: 3000,
      description: "clutch baron",
    },
  },
  {
    kind: "marker",
    id: "m2",
    at: START + 51 * MIN,
    marker: {
      id: "m2",
      created_at: START + 51 * MIN,
      position_seconds: 3060,
      description: "",
    },
  },
];

describe("Timeline", () => {
  afterEach(cleanup);

  it("plots what happened, now and the next ad", () => {
    const { container } = render(() => (
      <Timeline
        start={START}
        now={START + 100 * MIN}
        entries={entries}
        nextAd={{ at: START + 105 * MIN, secs: 90 }}
      />
    ));
    // 100 minutes in, the rail runs 15 minutes past now.
    const elapsed = container.querySelector<HTMLElement>(".sm-rail__elapsed")!;
    expect(parseFloat(elapsed.style.width)).toBeCloseTo((100 / 115) * 100);
    expect(container.querySelectorAll(".sm-rail__ad")).toHaveLength(1);
    expect(container.querySelectorAll(".sm-rail__tick")).toHaveLength(2);
    expect(container.querySelector(".sm-rail__next")).toBeTruthy();

    // A minute after the first marker there is no room for its label.
    const labels = [...container.querySelectorAll(".sm-rail__label")].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual([
      expect.stringMatching(/^Started /),
      "Ad break",
      "Marker: clutch baron",
      "Now",
      "Next ad",
    ]);

    const list = screen.getByRole("list", { name: "Stream timeline" });
    expect(list.textContent).toContain("Ad break, 3 min at");
    expect(list.textContent).toContain("Next ad, 90 sec, at");
  });

  it("leaves out events from before the stream and a past next ad", () => {
    const { container } = render(() => (
      <Timeline
        start={START + 30 * MIN}
        now={START + 40 * MIN}
        entries={entries}
        nextAd={{ at: START + 35 * MIN, secs: 60 }}
      />
    ));
    expect(container.querySelector(".sm-rail__ad")).toBeNull();
    expect(container.querySelector(".sm-rail__tick")).toBeNull();
    expect(container.querySelector(".sm-rail__next")).toBeNull();
    expect(container.textContent).not.toContain("Next ad");
  });
});
