import { describe, expect, it } from "vitest";
import { nameStyle } from "./paint";
import type { Paint } from "../stores/paintStore";

// Shapes as the host forwards them, converted from real 7TV cosmetic.create
// payloads ("Firebrand", "Candy Cane", "TwitchCon 2023 Las Vegas").
const firebrand: Paint = {
  id: "01HEBYHWN0000EV2G1SJ85XJQR",
  name: "Firebrand",
  function: "RADIAL_GRADIENT",
  angle: 0,
  shape: "circle",
  repeat: false,
  stops: [
    { at: 0.15, color: "#fff700ff" },
    { at: 0.3, color: "#ff9500ff" },
    { at: 1, color: "#db1d0fff" },
  ],
  shadows: [{ x: 0, y: 0, radius: 4, color: "#e00f00ff" }],
};

const candyCane: Paint = {
  id: "01FQ8S87J8000BDD0YMN21KEXG",
  name: "Candy Cane",
  function: "LINEAR_GRADIENT",
  angle: 45,
  shape: "circle",
  repeat: true,
  stops: [
    { at: 0.1, color: "#d2d2d2ff" },
    { at: 0.2, color: "#d2d2d2ff" },
    { at: 0.2, color: "#ff6464ff" },
    { at: 0.3, color: "#ff6464ff" },
  ],
  shadows: [
    { x: -1, y: 0, radius: 0.7, color: "#00000066" },
    { x: 1, y: 0, radius: 0.7, color: "#00000066" },
  ],
};

const twitchCon: Paint = {
  id: "01HBXZS5680009NC1Q0NCNE82C",
  name: "TwitchCon 2023 Las Vegas",
  function: "URL",
  angle: 0,
  shape: "circle",
  image_url:
    "https://cdn.7tv.app/paint/01HBXZS5680009NC1Q0NCNE82C/layer/01JAMR2BPQYF8Y2KQZF5Q6BDXR/1x.webp",
  repeat: false,
  stops: [],
  shadows: [],
};

describe("nameStyle", () => {
  it("keeps the plain chat color without a paint", () => {
    expect(nameStyle("#1e90ff", undefined, false)).toEqual({
      style: { color: "#1e90ff" },
      painted: false,
    });
  });

  it("builds a radial gradient with drop shadows", () => {
    const { style, painted } = nameStyle("#1e90ff", firebrand, false);
    expect(painted).toBe(true);
    expect(style).toEqual({
      color: "#1e90ff",
      "background-image":
        "radial-gradient(circle, #fff700ff 15%, #ff9500ff 30%, #db1d0fff 100%)",
      filter: "drop-shadow(0px 0px 4px #e00f00ff)",
    });
  });

  it("repeats a linear gradient at its angle", () => {
    const { style } = nameStyle(null, candyCane, false);
    expect(style["background-image"]).toBe(
      "repeating-linear-gradient(45deg, #d2d2d2ff 10%, #d2d2d2ff 20%, #ff6464ff 20%, #ff6464ff 30%)",
    );
    expect(style.filter).toBe(
      "drop-shadow(-1px 0px 0.7px #00000066) drop-shadow(1px 0px 0.7px #00000066)",
    );
  });

  it("uses the image of an image paint", () => {
    const { style, painted } = nameStyle("#1e90ff", twitchCon, false);
    expect(painted).toBe(true);
    expect(style["background-image"]).toBe(`url("${twitchCon.image_url}")`);
    expect(style.filter).toBeUndefined();
  });

  it("darkens pale stops on the light palette and keeps alpha", () => {
    const { style } = nameStyle(
      "#1e90ff",
      {
        ...firebrand,
        stops: [{ at: 0, color: "#fff70080" }],
        shadows: [],
      },
      true,
    );
    const stop = /radial-gradient\(circle, (#[0-9a-f]{8}) 0%\)/.exec(
      String(style["background-image"]),
    );
    expect(stop).not.toBeNull();
    expect(stop![1]).not.toBe("#fff70080");
    expect(stop![1]!.endsWith("80")).toBe(true);
  });

  it("takes the paint's own color when it has one", () => {
    const { style } = nameStyle(
      "#1e90ff",
      { ...firebrand, color: "#ff9500ff" },
      false,
    );
    expect(style.color).toBe("#ff9500");
  });

  it("falls back to the chat color when the paint cannot render", () => {
    for (const paint of [
      { ...firebrand, stops: [] },
      { ...twitchCon, image_url: undefined },
      { ...twitchCon, image_url: "not a url" },
      { ...twitchCon, image_url: "http://cdn.7tv.app/paint/x/1x.webp" },
    ]) {
      expect(nameStyle("#1e90ff", paint, false)).toEqual({
        style: { color: "#1e90ff" },
        painted: false,
      });
    }
  });

  it("escapes quotes in image urls", () => {
    const { style } = nameStyle(
      null,
      { ...twitchCon, image_url: 'https://cdn.7tv.app/a"b.webp' },
      false,
    );
    expect(style["background-image"]).toBe(
      'url("https://cdn.7tv.app/a%22b.webp")',
    );
  });
});
