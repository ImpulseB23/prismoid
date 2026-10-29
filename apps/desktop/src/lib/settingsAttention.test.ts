import { describe, expect, it } from "vitest";
import { settingsAttention, type AttentionInputs } from "./settingsAttention";

const calm: AttentionInputs = {
  missingScopes: [],
  update: { kind: "idle" },
  sidecar: "running",
  unseenUpdate: null,
  setupPending: false,
};

describe("settingsAttention", () => {
  it("is empty when nothing needs the user", () => {
    expect(settingsAttention(calm)).toEqual([]);
  });

  it("lists every cause, most urgent first, with its section and row", () => {
    const list = settingsAttention({
      missingScopes: ["moderator:manage:warnings"],
      update: { kind: "available", version: "0.8.3", notes: null },
      sidecar: "terminated",
      unseenUpdate: "0.8.2",
      setupPending: true,
    });
    expect(list.map((a) => [a.section, a.row])).toEqual([
      ["account", "reconnect"],
      ["updates", "update"],
      [undefined, undefined],
      ["updates", "update"],
      ["help", "setup"],
    ]);
    expect(list[1].text).toBe("Update to 0.8.3 is ready");
    expect(list[3].text).toBe("Updated to 0.8.2");
  });

  it("sends a sidecar waiting for sign-in to the account section", () => {
    expect(settingsAttention({ ...calm, sidecar: "waiting_for_auth" })).toEqual(
      [{ text: "Waiting for sign-in", section: "account" }],
    );
  });
});
