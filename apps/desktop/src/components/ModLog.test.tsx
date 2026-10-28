import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { ModAction } from "../lib/chatEvents";

vi.mock("../stores/channelStore", () => ({
  activeChannel: () => ({ id: "1", display_name: "Chan" }),
}));

const { recordModAction, clearModLog } = await import("../stores/modLogStore");
const { default: ModLog, matchesFilter } = await import("./ModLog");

const action = (verb: string, t: number, target = "42"): ModAction => ({
  kind: "mod_action",
  channel_id: "1",
  timestamp: t,
  moderator_login: "mod",
  moderator_name: "Mod",
  action: verb,
  target_user_id: target,
  target_user_login: "spammer",
  target_user_name: "Spammer",
  reason: "",
  duration_seconds: verb === "timeout" ? 600 : null,
  message_id: "",
  message_body: "",
  wait_time_seconds: verb === "slow" ? 30 : null,
  follow_duration_minutes: null,
  viewer_count: null,
  terms: [],
  moderator_message: "",
});

describe("matchesFilter", () => {
  it("sorts actions into their groups", () => {
    expect(matchesFilter(action("ban", 0), "punish")).toBe(true);
    expect(matchesFilter(action("delete", 0), "delete")).toBe(true);
    expect(matchesFilter(action("clear", 0, ""), "delete")).toBe(true);
    expect(matchesFilter(action("slow", 0, ""), "modes")).toBe(true);
    expect(matchesFilter(action("ban", 0), "modes")).toBe(false);
    expect(matchesFilter(action("slow", 0, ""), "all")).toBe(true);
  });
});

describe("ModLog", () => {
  afterEach(() => {
    cleanup();
    clearModLog();
  });

  it("lists the channel's actions newest first and filters them", () => {
    render(() => <ModLog open onClose={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toContain("Nothing yet");
    recordModAction(action("timeout", 1));
    recordModAction(action("slow", 2, ""));
    const items = () => screen.getAllByRole("listitem");
    expect(items()).toHaveLength(2);
    expect(items()[0].textContent).toContain("slow mode");
    fireEvent.click(screen.getByRole("tab", { name: "Timeouts and bans" }));
    expect(items()).toHaveLength(1);
    expect(items()[0].textContent).toContain("timed out Spammer");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(() => <ModLog open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
