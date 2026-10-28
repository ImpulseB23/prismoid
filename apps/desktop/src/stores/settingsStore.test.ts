import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  ZOOM_LEVELS,
  createSettingsStore,
  parseDurations,
  parseList,
  type SettingsAppliers,
} from "./settingsStore";
import type { StorageLike } from "./channelStore";

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
} {
  const tops: boolean[] = [];
  const zooms: number[] = [];
  return {
    tops,
    zooms,
    alwaysOnTop: async (v) => {
      tops.push(v);
    },
    zoom: async (v) => {
      zooms.push(v);
    },
    followBrowser: async () => {},
    chatBacklog: async () => {},
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
      showTimestamps: false,
      ignoredLogins: [],
      highlightPhrases: [],
      flagNewAccounts: true,
      showModActions: true,
      timeoutPresets: [60, 600, 3600, 86_400],
      followBrowser: false,
      chatBacklog: true,
      tourDone: false,
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

  it("leaves state untouched when the window call fails", async () => {
    const store = createSettingsStore(
      {
        alwaysOnTop: async () => {
          throw new Error("no window");
        },
        zoom: async () => {},
        followBrowser: async () => {},
        chatBacklog: async () => {},
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
        }),
      }),
    );
    expect(good.settings()).toEqual({
      alwaysOnTop: true,
      zoom: 1.5,
      showTimestamps: false,
      ignoredLogins: [],
      highlightPhrases: [],
      flagNewAccounts: true,
      showModActions: true,
      timeoutPresets: [60, 600, 3600, 86_400],
      followBrowser: false,
      chatBacklog: true,
      tourDone: false,
    });

    const badZoom = createSettingsStore(
      appliers(),
      memStorage({ "prismoid.settings": JSON.stringify({ zoom: 3.3 }) }),
    );
    expect(badZoom.settings().zoom).toBe(1);

    const garbage = createSettingsStore(
      appliers(),
      memStorage({ "prismoid.settings": "{nope" }),
    );
    expect(garbage.settings()).toEqual(DEFAULT_SETTINGS);
  });

  it("apply only touches the window for non-default values", async () => {
    const a = appliers();
    const store = createSettingsStore(
      a,
      memStorage({
        "prismoid.settings": JSON.stringify({ alwaysOnTop: true, zoom: 1.25 }),
      }),
    );
    await store.apply();
    expect(a.tops).toEqual([true]);
    expect(a.zooms).toEqual([1.25]);

    const b = appliers();
    const plain = createSettingsStore(b, memStorage());
    await plain.apply();
    expect(b.tops).toEqual([]);
    expect(b.zooms).toEqual([]);
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
