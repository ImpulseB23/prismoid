import { describe, expect, it } from "vitest";
import { displayVersion } from "./version";

describe("displayVersion", () => {
  it("drops a zero patch", () => {
    expect(displayVersion("1.3.0")).toBe("1.3");
    expect(displayVersion("1.0.0")).toBe("1.0");
    expect(displayVersion("0.10.0")).toBe("0.10");
  });

  it("keeps a patch release whole", () => {
    expect(displayVersion("1.3.4")).toBe("1.3.4");
    expect(displayVersion("0.6.10")).toBe("0.6.10");
  });

  it("leaves pre-releases and odd strings alone", () => {
    expect(displayVersion("1.3.0-beta.1")).toBe("1.3.0-beta.1");
    expect(displayVersion("1.3")).toBe("1.3");
    expect(displayVersion("")).toBe("");
  });
});
