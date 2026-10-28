import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import ProviderIcon from "./ProviderIcon";

describe("ProviderIcon", () => {
  afterEach(cleanup);

  it("draws twitch and 7tv as vectors", () => {
    const { container } = render(() => (
      <>
        <ProviderIcon provider="twitch" />
        <ProviderIcon provider="7tv" size={20} />
      </>
    ));
    const [twitch, seventv] = container.querySelectorAll("svg");
    expect(twitch.classList.contains("provider-icon--twitch")).toBe(true);
    expect(twitch.getAttribute("width")).toBe("14");
    expect(seventv.classList.contains("provider-icon--7tv")).toBe(true);
    expect(seventv.getAttribute("height")).toBe("20");
  });

  it("uses each site icon for bttv and ffz", () => {
    const { container } = render(() => (
      <>
        <ProviderIcon provider="bttv" />
        <ProviderIcon provider="ffz" size={18} />
      </>
    ));
    const [bttv, ffz] = container.querySelectorAll("img");
    expect(bttv.getAttribute("src")).toMatch(/bttv/);
    expect(ffz.getAttribute("src")).toMatch(/ffz/);
    expect(ffz.getAttribute("width")).toBe("18");
  });
});
