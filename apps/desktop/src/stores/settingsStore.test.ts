import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  ZOOM_LEVELS,
  createSettingsStore,
  parseDurations,
  parseList,
  type SettingsAppliers,
  type Theme,
} from "./settingsStore";
import type { StorageLike } from "./channelStore";
import { TEXT_SIZES } from "../lib/messageLayout";

function memStorage(seed: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function appliers(): SettingsAppliers & {
  tops: boolean[];
  zooms: number[];
  themes: Theme[];
  firsts: boolean[];
  paints: boolean[];
} {
  const tops: boolean[] = [];
  const zooms: number[] = [];
  const themes: Theme[] = [];
  const firsts: boolean[] = [];
  const paints: boolean[] = [];
  return {
    tops,
    zooms,
    themes,
    firsts,
    paints,
    alwaysOnTop: async (v) => {
      tops.push(v);
    },
    zoom: async (v) => {
      zooms.push(v);
    },
    followBrowser: async () => {},
    chatBacklog: async () => {},
    closeToTray: async () => {},
    highlightFirstMessages: async (v) => {
      firsts.push(v);
    },
    showPaints: async (v) => {
      paints.push(v);
    },
    theme: async (v) => {
      themes.push(v);
    },
  };
}

describe("settingsStore", () => {
  it("starts from defaults and persists updates as one JSON blob", async () => {
    const a = appliers();
    const storage = memStorage();
    const store = createSettingsStore(a, storage);
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);

    await store.update({ alwaysOnTop: true, showTimestamps: false });
    expect(a.tops).toEqual([true]);
    expect(a.zooms).toEqual([]);
    expect(JSON.parse(storage.data["prismoid.settings"]!)).toEqual({
      alwaysOnTop: true,
      zoom: 1,
      textSize: 20,
      v: 2,
      showTimestamps: false,
      alternateRows: false,
      readableColors: true,
      pauseChat: "scroll",
      animatedEmotes: true,
      splitView: true,
      streamVideo: true,
      hideViewers: false,
      hideUptime: false,
      hideChatRate: false,
      hideChatters: false,
      ignoredLogins: [],
      highlightUsers: [],
      highlightBadges: [],
      highlightPhrases: [],
      showPaints: true,
      flagNewAccounts: true,
      showModActions: true,
      timeoutPresets: [60, 600, 3600, 86_400],
      defaultSlowSeconds: 5,
      defaultFollowerMinutes: 0,
      followBrowser: false,
      chatBacklog: true,
      closeToTray: false,
      highlightFirstMessages: true,
      setupDone: false,
      mentionAlerts: true,
      chimeAlways: false,
      chimeVolume: 1,
      theme: "dark",
      streamManagerHeight: 0.58,
    });
  });

  it("announces saves and re-reads what another window saved", async () => {
    const storage = memStorage();
    const here = createSettingsStore(appliers(), storage);
    const there = createSettingsStore(appliers(), storage);
    const announce = vi.fn();
    here.onSave(announce);
    await here.update({ highlightUsers: ["kit"] });
    expect(announce).toHaveBeenCalledOnce();
    expect(there.settings().highlightUsers).toEqual([]);
    there.reload();
    expect(there.settings().highlightUsers).toEqual(["kit"]);
  });

  it("zoom steps along the ladder and clamps at the ends", async () => {
    const a = appliers();
    const store = createSettingsStore(a, memStorage());
    await store.zoomIn();
    await store.zoomIn();
    expect(store.settings().zoom).toBe(1.25);
    await store.zoomReset();
    expect(store.settings().zoom).toBe(1);
    for (let i = 0; i < ZOOM_LEVELS.length + 2; i++) await store.zoomOut();
    expect(store.settings().zoom).toBe(ZOOM_LEVELS[0]);
    expect(a.zooms.at(-1)).toBe(ZOOM_LEVELS[0]);
  });

  it("text size steps without touching window zoom", async () => {
    const a = appliers();
    const store = createSettingsStore(a, memStorage());
    await store.textBigger();
    expect(store.settings().textSize).toBe(22);
    expect(store.settings().zoom).toBe(1);
    expect(a.zooms).toEqual([]);
    for (let i = 0; i < TEXT_SIZES.length + 2; i++) await store.textSmaller();
    expect(store.settings().textSize).toBe(TEXT_SIZES[0]);
    await store.textReset();
    expect(store.settings().textSize).toBe(20);

    await store.update({ textSize: 17 });
    await store.textBigger();
    expect(store.settings().textSize).toBe(22);

    const odd = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({ textSize: 99, v: 2 }),
      }),
    );
    expect(odd.settings().textSize).toBe(20);
  });

  it("leaves state untouched when the window call fails", async () => {
    const store = createSettingsStore(
      {
        alwaysOnTop: async () => {
          throw new Error("no window");
        },
        zoom: async () => {},
        followBrowser: async () => {},
        chatBacklog: async () => {},
        closeToTray: async () => {},
        highlightFirstMessages: async () => {},
        showPaints: async () => {},
        theme: async () => {},
      },
      memStorage(),
    );
    await expect(store.update({ alwaysOnTop: true })).rejects.toThrow(
      "no window",
    );
    expect(store.settings().alwaysOnTop).toBe(false);
  });

  it("migrates sizes saved before they became relative", () => {
    const untouched = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({ zoom: 1, textSize: 15 }),
      }),
    );
    expect(untouched.settings().zoom).toBe(1);
    expect(untouched.settings().textSize).toBe(20);

    const chosen = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({ zoom: 1.5, textSize: 18 }),
      }),
    );
    expect(chosen.settings().zoom).toBe(1);
    expect(chosen.settings().textSize).toBe(24);
  });

  it("hydrates valid values and drops malformed ones", () => {
    const good = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({
          v: 2,
          alwaysOnTop: true,
          zoom: 1.5,
          showTimestamps: "yes",
          highlightUsers: ["Friend", 3],
          highlightBadges: ["vip", "owner"],
          mentionAlerts: false,
          chimeAlways: true,
          chimeVolume: 1.5,
          theme: "neon",
          showPaints: false,
          readableColors: false,
          pauseChat: "always",
          animatedEmotes: 0,
          streamVideo: false,
        }),
      }),
    );
    expect(good.settings()).toEqual({
      alwaysOnTop: true,
      zoom: 1.5,
      textSize: 20,
      showTimestamps: false,
      alternateRows: false,
      readableColors: false,
      pauseChat: "scroll",
      animatedEmotes: true,
      splitView: true,
      streamVideo: false,
      hideViewers: false,
      hideUptime: false,
      hideChatRate: false,
      hideChatters: false,
      ignoredLogins: [],
      highlightUsers: ["Friend"],
      highlightBadges: ["vip"],
      highlightPhrases: [],
      showPaints: false,
      flagNewAccounts: true,
      showModActions: true,
      timeoutPresets: [60, 600, 3600, 86_400],
      defaultSlowSeconds: 5,
      defaultFollowerMinutes: 0,
      followBrowser: false,
      chatBacklog: true,
      closeToTray: false,
      highlightFirstMessages: true,
      setupDone: false,
      mentionAlerts: false,
      chimeAlways: true,
      chimeVolume: 1,
      theme: "dark",
      streamManagerHeight: 0.58,
    });

    const badZoom = createSettingsStore(
      appliers(),
      memStorage({ "prismoid.settings": JSON.stringify({ zoom: 3.3, v: 2 }) }),
    );
    expect(badZoom.settings().zoom).toBe(1);

    const midnight = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({ theme: "midnight" }),
      }),
    );
    expect(midnight.settings().theme).toBe("midnight");

    const garbage = createSettingsStore(
      appliers(),
      memStorage({ "prismoid.settings": "{nope" }),
    );
    expect(garbage.settings()).toEqual(DEFAULT_SETTINGS);
  });

  it("applies close to tray at boot and on change", async () => {
    const trays: boolean[] = [];
    const a = {
      ...appliers(),
      closeToTray: async (v: boolean) => void trays.push(v),
    };
    const store = createSettingsStore(
      a,
      memStorage({
        "prismoid.settings": JSON.stringify({ closeToTray: true }),
      }),
    );
    await store.apply();
    expect(trays).toEqual([true]);
    await store.update({ closeToTray: false });
    expect(trays).toEqual([true, false]);
    expect(store.settings().closeToTray).toBe(false);
  });

  it("apply restores window state and pins the title bar theme", async () => {
    const a = appliers();
    const store = createSettingsStore(
      a,
      memStorage({
        "prismoid.settings": JSON.stringify({
          v: 2,
          alwaysOnTop: true,
          zoom: 1.25,
          theme: "light",
        }),
      }),
    );
    await store.apply();
    expect(a.tops).toEqual([true]);
    expect(a.zooms).toEqual([1.25]);
    expect(a.themes).toEqual(["light"]);

    const b = appliers();
    const plain = createSettingsStore(b, memStorage());
    await plain.apply();
    expect(b.tops).toEqual([]);
    expect(b.zooms).toEqual([1]);
    expect(b.themes).toEqual(["dark"]);

    const c = appliers();
    const system = createSettingsStore(
      c,
      memStorage({ "prismoid.settings": JSON.stringify({ theme: "system" }) }),
    );
    await system.apply();
    expect(c.themes).toEqual([]);
    await system.update({ theme: "midnight" });
    expect(c.themes).toEqual(["midnight"]);
    expect(vi.isMockFunction(b.zoom)).toBe(false);
  });

  it("tells the host when first-time chatter highlights change", async () => {
    const a = appliers();
    const on = createSettingsStore(a, memStorage());
    await on.apply();
    expect(a.firsts).toEqual([]);
    await on.update({ highlightFirstMessages: false });
    await on.update({ highlightFirstMessages: false });
    await on.update({ highlightFirstMessages: true });
    expect(a.firsts).toEqual([false, true]);

    const b = appliers();
    const off = createSettingsStore(
      b,
      memStorage({
        "prismoid.settings": JSON.stringify({
          highlightFirstMessages: false,
        }),
      }),
    );
    expect(off.settings().highlightFirstMessages).toBe(false);
    await off.apply();
    expect(b.firsts).toEqual([false]);
  });

  it("tells the host when 7tv paints change", async () => {
    const a = appliers();
    const on = createSettingsStore(a, memStorage());
    await on.apply();
    expect(a.paints).toEqual([]);
    await on.update({ showPaints: false });
    await on.update({ showPaints: false });
    await on.update({ showPaints: true });
    expect(a.paints).toEqual([false, true]);

    const b = appliers();
    const off = createSettingsStore(
      b,
      memStorage({
        "prismoid.settings": JSON.stringify({ showPaints: false }),
      }),
    );
    await off.apply();
    expect(b.paints).toEqual([false]);
  });
});

describe("settingsStore lists", () => {
  it("hydrates string lists and drops junk entries", () => {
    const storage = memStorage({
      "prismoid.settings": JSON.stringify({
        ignoredLogins: ["bot", 3, null],
        highlightPhrases: "nope",
      }),
    });
    const s = createSettingsStore(appliers(), storage);
    expect(s.settings().ignoredLogins).toEqual(["bot"]);
    expect(s.settings().highlightPhrases).toEqual([]);
  });

  it("hydrates timeout presets and parses duration lists", () => {
    const s = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({
          timeoutPresets: [30, "x", 30, 0, 2_000_000, 600],
        }),
      }),
    );
    expect(s.settings().timeoutPresets).toEqual([30, 600]);
    expect(parseDurations("1m, 10m, 1h30m, 1d")).toEqual([
      60, 600, 5400, 86_400,
    ]);
    expect(parseDurations("5m, nope, 5m")).toEqual([300]);
    expect(parseDurations("nope")).toBeNull();
    expect(parseDurations("3w")).toEqual([60, 600, 3600, 86_400]);
  });

  it("keeps a stream manager height only within bounds", () => {
    const height = (v: unknown) =>
      createSettingsStore(
        appliers(),
        memStorage({
          "prismoid.settings": JSON.stringify({ streamManagerHeight: v }),
        }),
      ).settings().streamManagerHeight;
    expect(height(0.7)).toBe(0.7);
    expect(height(0.2)).toBe(0.58);
    expect(height(0.9)).toBe(0.58);
    expect(height("0.7")).toBe(0.58);
  });

  it("parseList trims, dedupes and optionally lowercases", () => {
    expect(parseList(" Bot, spam\nbot ,", true)).toEqual(["bot", "spam"]);
    expect(parseList("Prismoid, GG")).toEqual(["Prismoid", "GG"]);
  });
});
