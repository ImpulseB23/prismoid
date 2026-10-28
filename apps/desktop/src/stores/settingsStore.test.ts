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
} {
  const tops: boolean[] = [];
  const zooms: number[] = [];
  const themes: Theme[] = [];
  return {
    tops,
    zooms,
    themes,
    alwaysOnTop: async (v) => {
      tops.push(v);
    },
    zoom: async (v) => {
      zooms.push(v);
    },
    followBrowser: async () => {},
    chatBacklog: async () => {},
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
      textSize: 15,
      showTimestamps: false,
      ignoredLogins: [],
      highlightUsers: [],
      highlightBadges: [],
      highlightPhrases: [],
      flagNewAccounts: true,
      showModActions: true,
      timeoutPresets: [60, 600, 3600, 86_400],
      followBrowser: false,
      chatBacklog: true,
      tourDone: false,
      mentionAlerts: true,
      theme: "dark",
    });
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
    expect(store.settings().textSize).toBe(16);
    expect(store.settings().zoom).toBe(1);
    expect(a.zooms).toEqual([]);
    for (let i = 0; i < TEXT_SIZES.length + 2; i++) await store.textSmaller();
    expect(store.settings().textSize).toBe(TEXT_SIZES[0]);
    await store.textReset();
    expect(store.settings().textSize).toBe(15);

    await store.update({ textSize: 17 });
    await store.textBigger();
    expect(store.settings().textSize).toBe(16);

    const odd = createSettingsStore(
      appliers(),
      memStorage({ "prismoid.settings": JSON.stringify({ textSize: 99 }) }),
    );
    expect(odd.settings().textSize).toBe(15);
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
        theme: async () => {},
      },
      memStorage(),
    );
    await expect(store.update({ alwaysOnTop: true })).rejects.toThrow(
      "no window",
    );
    expect(store.settings().alwaysOnTop).toBe(false);
  });

  it("hydrates valid values and drops malformed ones", () => {
    const good = createSettingsStore(
      appliers(),
      memStorage({
        "prismoid.settings": JSON.stringify({
          alwaysOnTop: true,
          zoom: 1.5,
          showTimestamps: "yes",
          highlightUsers: ["Friend", 3],
          highlightBadges: ["vip", "owner"],
          mentionAlerts: false,
          theme: "neon",
        }),
      }),
    );
    expect(good.settings()).toEqual({
      alwaysOnTop: true,
      zoom: 1.5,
      textSize: 15,
      showTimestamps: false,
      ignoredLogins: [],
      highlightUsers: ["Friend"],
      highlightBadges: ["vip"],
      highlightPhrases: [],
      flagNewAccounts: true,
      showModActions: true,
      timeoutPresets: [60, 600, 3600, 86_400],
      followBrowser: false,
      chatBacklog: true,
      tourDone: false,
      mentionAlerts: false,
      theme: "dark",
    });

    const badZoom = createSettingsStore(
      appliers(),
      memStorage({ "prismoid.settings": JSON.stringify({ zoom: 3.3 }) }),
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

  it("apply restores window state and pins the title bar theme", async () => {
    const a = appliers();
    const store = createSettingsStore(
      a,
      memStorage({
        "prismoid.settings": JSON.stringify({
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
    expect(b.zooms).toEqual([]);
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

  it("parseList trims, dedupes and optionally lowercases", () => {
    expect(parseList(" Bot, spam\nbot ,", true)).toEqual(["bot", "spam"]);
    expect(parseList("Prismoid, GG")).toEqual(["Prismoid", "GG"]);
  });
});
