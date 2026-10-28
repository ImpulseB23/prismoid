import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadImages } from "./preload";

const loaded: string[] = [];
let decode: () => Promise<void>;

class FakeImage {
  set src(url: string) {
    loaded.push(url);
  }
  decode() {
    return decode();
  }
}

describe("preloadImages", () => {
  beforeEach(() => {
    loaded.length = 0;
    decode = () => Promise.resolve();
    vi.stubGlobal("Image", FakeImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads each url once and skips blanks", async () => {
    await preloadImages(["a", "", "b", "a"]);
    expect(loaded).toEqual(["a", "b"]);
  });

  it("resolves at once with nothing to load", async () => {
    await preloadImages(["", ""]);
    expect(loaded).toEqual([]);
  });

  it("treats a broken image as done", async () => {
    decode = () => Promise.reject(new Error("bad"));
    await expect(preloadImages(["a"])).resolves.toBeUndefined();
  });

  it("gives up after the cap", async () => {
    vi.useFakeTimers();
    decode = () => new Promise(() => {});
    let done = false;
    void preloadImages(["slow"], 200).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(199);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
