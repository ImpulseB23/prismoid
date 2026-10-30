import { describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { MAX_PANES, createLayoutStore } from "./layoutStore";

function memStorage(initial?: unknown) {
  const map = new Map<string, string>();
  if (initial !== undefined)
    map.set("prismoid.layout", JSON.stringify(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    saved: () => JSON.parse(map.get("prismoid.layout") ?? "null"),
  };
}

const channels = (s: ReturnType<typeof createLayoutStore>) =>
  s.panes().map((p) => p.channelId);

describe("layoutStore", () => {
  it("starts with one empty pane that shows what the tabs pick", () => {
    const s = createLayoutStore(memStorage());
    expect(channels(s)).toEqual([null]);
    s.show("a");
    expect(channels(s)).toEqual(["a"]);
    expect(s.focusedChannel()).toBe("a");
    s.show("b");
    expect(channels(s)).toEqual(["b"]);
  });

  it("splits to the right of the focused pane and focuses the new one", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    expect(s.split("b")).toBe(true);
    expect(channels(s)).toEqual(["a", "b"]);
    expect(s.focusedChannel()).toBe("b");
    s.focus(s.panes()[0]!.id);
    expect(s.split("c")).toBe(true);
    expect(channels(s)).toEqual(["a", "c", "b"]);
  });

  it("shows a channel in one pane only, focusing it instead", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.split("b");
    expect(s.split("a")).toBe(false);
    expect(s.focusedChannel()).toBe("a");
    s.show("b");
    expect(channels(s)).toEqual(["a", "b"]);
    expect(s.focusedChannel()).toBe("b");
    s.showIn(s.panes()[0]!.id, "b");
    expect(channels(s)).toEqual(["a", "b"]);
  });

  it("stops at the pane limit", () => {
    const s = createLayoutStore(memStorage());
    s.show("c0");
    for (let i = 1; i < MAX_PANES; i++) expect(s.split(`c${i}`)).toBe(true);
    expect(s.canSplit()).toBe(false);
    expect(s.split("extra")).toBe(false);
    expect(s.panes()).toHaveLength(MAX_PANES);
  });

  it("closes panes to the left neighbour but never the last", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.split("b");
    s.split("c");
    s.close(s.panes()[2]!.id);
    expect(channels(s)).toEqual(["a", "b"]);
    expect(s.focusedChannel()).toBe("b");
    s.close(s.panes()[0]!.id);
    expect(channels(s)).toEqual(["b"]);
    expect(s.focusedChannel()).toBe("b");
    s.close(s.panes()[0]!.id);
    expect(channels(s)).toEqual(["b"]);
  });

  it("follows closed tabs and drops channels that are gone", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.split("b");
    s.split("c");
    s.drop("b");
    expect(channels(s)).toEqual(["a", "c"]);
    s.keepOnly(new Set(["c"]));
    expect(channels(s)).toEqual(["c"]);
    s.drop("c");
    expect(channels(s)).toEqual([null]);
  });

  it("remembers the video per pane", () => {
    const store = memStorage();
    const s = createLayoutStore(store);
    s.show("a");
    s.split("b");
    const [first, second] = s.panes().map((p) => p.id);
    s.toggleVideo(first!);
    const videos = (l: typeof s) => l.panes().map((p) => p.videoChannelId);
    expect(videos(s)).toEqual(["a", null]);
    const again = createLayoutStore(memStorage(store.saved()));
    expect(videos(again)).toEqual(["a", null]);
    again.toggleVideo(first!);
    again.toggleVideo(second!);
    expect(videos(again)).toEqual([null, "b"]);
  });

  it("keeps a channel's stream in the corner while the pane shows another", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.toggleVideo(s.focusedId());
    s.show("b");
    expect(s.panes()[0]).toMatchObject({ channelId: "b", videoChannelId: "a" });
    // The button on b swaps the corner to b; again hides it.
    s.toggleVideo(s.focusedId());
    expect(s.panes()[0]!.videoChannelId).toBe("b");
    s.toggleVideo(s.focusedId());
    expect(s.panes()[0]!.videoChannelId).toBeNull();
  });

  it("stops a stream when its tab closes, shown or not", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.toggleVideo(s.focusedId());
    s.show("b");
    s.drop("a");
    expect(s.panes()[0]!.videoChannelId).toBeNull();
    s.toggleVideo(s.focusedId());
    s.show("c");
    s.keepOnly(new Set(["c"]));
    expect(s.panes()[0]!.videoChannelId).toBeNull();
  });

  it("reads layouts saved with the old video flag", () => {
    const s = createLayoutStore(
      memStorage({
        panes: [
          { id: "p1", channelId: "a", video: true },
          { id: "p2", channelId: "b", video: false },
        ],
        focused: "p1",
      }),
    );
    expect(s.panes().map((p) => p.videoChannelId)).toEqual(["a", null]);
  });

  it("comes back as it was saved and ignores what it cannot use", () => {
    const store = memStorage();
    const s = createLayoutStore(store);
    s.show("a");
    s.split("b");
    s.focus(s.panes()[0]!.id);
    const again = createLayoutStore(memStorage(store.saved()));
    expect(channels(again)).toEqual(["a", "b"]);
    expect(again.focusedChannel()).toBe("a");

    const broken = createLayoutStore(
      memStorage({ panes: [{ id: 1 }, { id: "x", channelId: "z" }] }),
    );
    expect(channels(broken)).toEqual(["z"]);
    expect(channels(createLayoutStore(memStorage("nope")))).toEqual([null]);
  });

  it("refuses splits and video while their features are off", () => {
    const [split, setSplit] = createSignal(true);
    const [video, setVideo] = createSignal(true);
    const s = createLayoutStore(memStorage(), { split, video });
    s.show("a");
    s.split("b");
    s.setVideo(s.focusedId(), true);
    setSplit(false);
    setVideo(false);
    expect(s.canSplit()).toBe(false);
    expect(s.split("c")).toBe(false);
    s.collapse();
    expect(channels(s)).toEqual(["b"]);
    s.toggleVideo(s.focusedId());
    expect(s.panes()[0]!.videoChannelId).toBeNull();
    s.setVideo(s.focusedId(), true);
    expect(s.panes()[0]!.videoChannelId).toBeNull();
  });

  it("clears every pane's video", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.setVideo(s.focusedId(), true);
    s.split("b");
    s.setVideo(s.focusedId(), true);
    s.clearVideo();
    expect(s.panes().map((p) => p.videoChannelId)).toEqual([null, null]);
  });

  it("swaps two panes and keeps focus where it was", () => {
    const s = createLayoutStore(memStorage());
    s.show("a");
    s.split("b");
    s.split("c");
    const [p1, , p3] = s.panes().map((p) => p.id);
    s.swap(p1!, p3!);
    expect(channels(s)).toEqual(["c", "b", "a"]);
    expect(s.focusedChannel()).toBe("c");
    s.swap(p1!, "missing");
    expect(channels(s)).toEqual(["c", "b", "a"]);
  });
});
