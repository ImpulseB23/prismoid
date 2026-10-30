import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChannelStore,
  pushRecent,
  RECENT_DWELL_MS,
  MAX_RECENTS,
  type ChannelCommands,
  type StorageLike,
} from "./channelStore";
import type { Channel } from "../lib/twitchChannel";

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

function chan(login: string): Channel {
  return {
    id: `id-${login}`,
    login,
    display_name: login.toUpperCase(),
    profile_image_url: `https://img/${login}.png`,
  };
}

function fakeCommands(
  join: (login: string) => Promise<Channel> = async (l) => chan(l),
): ChannelCommands & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    join: async (l) => {
      log.push(`join ${l}`);
      return join(l);
    },
    leave: async (id) => {
      log.push(`leave ${id}`);
    },
    focus: async (id) => {
      log.push(`focus ${id}`);
      return true;
    },
    rejoin: async (id) => {
      log.push(`rejoin ${id}`);
    },
  };
}

describe("createChannelStore", () => {
  it("select opens a tab, shows it and persists last + recents + tabs", async () => {
    const storage = memStorage();
    const store = createChannelStore(fakeCommands(), storage);

    expect(store.status()).toBe("idle");
    const p = store.select("xqc", { remember: true });
    expect(store.status()).toBe("connecting");
    await p;

    expect(store.active()?.id).toBe("id-xqc");
    expect(store.tabs().map((c) => c.login)).toEqual(["xqc"]);
    expect(store.status()).toBe("ready");
    expect(store.lastLogin()).toBe("xqc");
    expect(store.recents().map((r) => r.login)).toEqual(["xqc"]);
    expect(JSON.parse(storage.data["prismoid.channels.tabs"]!)).toEqual([
      "xqc",
    ]);
  });

  it("select of an open tab focuses it without a duplicate", async () => {
    const store = createChannelStore(fakeCommands(), memStorage());
    await store.select("a");
    await store.select("b");
    await store.select("a");
    expect(store.tabs().map((c) => c.login)).toEqual(["a", "b"]);
    expect(store.active()?.login).toBe("a");
  });

  it("failure records error and keeps the previous channel", async () => {
    const store = createChannelStore(
      fakeCommands(async (l) => {
        if (l === "bad") throw { kind: "not_found", login: l };
        return chan(l);
      }),
      memStorage(),
    );
    await store.select("good");
    await expect(store.select("bad")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(store.active()?.login).toBe("good");
    expect(store.status()).toBe("ready");
    expect(store.error()).toMatchObject({ kind: "not_found" });
  });

  it("failure with no prior channel lands in error state", async () => {
    const store = createChannelStore(
      fakeCommands(async () => {
        throw new Error("nope");
      }),
      memStorage(),
    );
    await expect(store.select("x")).rejects.toThrow("nope");
    expect(store.active()).toBeNull();
    expect(store.status()).toBe("error");
  });

  it("later select wins over a slower earlier one", async () => {
    let resolveSlow!: (c: Channel) => void;
    const store = createChannelStore(
      fakeCommands((l) =>
        l === "slow"
          ? new Promise<Channel>((r) => {
              resolveSlow = r;
            })
          : Promise.resolve(chan(l)),
      ),
      memStorage(),
    );
    const slow = store.select("slow");
    await store.select("fast");
    resolveSlow(chan("slow"));
    await slow;
    expect(store.active()?.login).toBe("fast");
    expect(store.tabs().map((c) => c.login)).toEqual(["fast"]);
  });

  it("focus and close move between tabs and talk to the host", async () => {
    const commands = fakeCommands();
    const storage = memStorage();
    const store = createChannelStore(commands, storage);
    await store.select("a");
    await store.select("b");
    await store.select("c");

    await store.focus("id-a");
    expect(store.active()?.login).toBe("a");
    expect(commands.log).toContain("focus id-a");

    await store.close("id-a");
    expect(store.tabs().map((c) => c.login)).toEqual(["b", "c"]);
    expect(store.active()?.login).toBe("b");
    expect(commands.log).toContain("leave id-a");
    expect(JSON.parse(storage.data["prismoid.channels.tabs"]!)).toEqual([
      "b",
      "c",
    ]);

    await store.close("id-c");
    expect(store.active()?.login).toBe("b");
    await store.close("id-b");
    expect(store.active()).toBeNull();
    expect(store.tabs()).toEqual([]);
  });

  it("restore reopens saved tabs and shows the remembered one", async () => {
    const commands = fakeCommands();
    const storage = memStorage({
      "prismoid.channels.tabs": JSON.stringify(["a", "b", "c"]),
      "prismoid.channels.last": "b",
    });
    const store = createChannelStore(commands, storage);
    await store.restore("me");
    expect(store.tabs().map((c) => c.login)).toEqual(["a", "b", "c"]);
    expect(store.active()?.login).toBe("b");
    expect(commands.log).toEqual(["join a", "join b", "join c", "focus id-b"]);
    expect(store.status()).toBe("ready");
  });

  it("restore falls back to the given login on a fresh install", async () => {
    const commands = fakeCommands();
    const store = createChannelStore(commands, memStorage());
    await store.restore("me");
    expect(store.tabs().map((c) => c.login)).toEqual(["me"]);
    expect(store.active()?.login).toBe("me");
    expect(commands.log).toEqual(["join me"]);
  });

  it("restore skips channels that no longer resolve", async () => {
    const store = createChannelStore(
      fakeCommands(async (l) => {
        if (l === "gone") throw { kind: "not_found", login: l };
        return chan(l);
      }),
      memStorage({
        "prismoid.channels.tabs": JSON.stringify(["gone", "ok"]),
        "prismoid.channels.last": "gone",
      }),
    );
    await store.restore("me");
    expect(store.tabs().map((c) => c.login)).toEqual(["ok"]);
    expect(store.active()?.login).toBe("ok");
  });

  it("hydrates recents and ignores malformed storage", () => {
    const good = memStorage({
      "prismoid.channels.recent": JSON.stringify([
        { login: "a", display_name: "A", profile_image_url: "" },
        { bogus: true },
      ]),
    });
    expect(
      createChannelStore(fakeCommands(), good)
        .recents()
        .map((r) => r.login),
    ).toEqual(["a"]);
    const broken = memStorage({ "prismoid.channels.recent": "{not json" });
    expect(createChannelStore(fakeCommands(), broken).recents()).toEqual([]);
  });

  it("forgetRecent removes and persists", async () => {
    const storage = memStorage();
    const store = createChannelStore(fakeCommands(), storage);
    await store.select("a", { remember: true });
    await store.select("b", { remember: true });
    store.forgetRecent("a");
    expect(store.recents().map((r) => r.login)).toEqual(["b"]);
    expect(
      JSON.parse(storage.data["prismoid.channels.recent"]!).map(
        (r: { login: string }) => r.login,
      ),
    ).toEqual(["b"]);
  });

  describe("recents from other opens", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("joins recents only after staying on screen", async () => {
      vi.useFakeTimers();
      const store = createChannelStore(fakeCommands(), memStorage());
      await store.select("a");
      expect(store.recents()).toEqual([]);
      vi.advanceTimersByTime(RECENT_DWELL_MS);
      expect(store.recents().map((r) => r.login)).toEqual(["a"]);
    });

    it("drops a channel left before the dwell ends", async () => {
      vi.useFakeTimers();
      const store = createChannelStore(fakeCommands(), memStorage());
      await store.select("a");
      vi.advanceTimersByTime(RECENT_DWELL_MS - 1);
      await store.select("b");
      vi.advanceTimersByTime(RECENT_DWELL_MS - 1);
      await store.close("id-b");
      vi.advanceTimersByTime(RECENT_DWELL_MS);
      expect(store.recents().map((r) => r.login)).toEqual(["a"]);
    });
  });

  it("survives a throwing storage", async () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createChannelStore(fakeCommands(), throwing);
    await store.select("a");
    expect(store.active()?.login).toBe("a");
    expect(store.lastLogin()).toBeNull();
  });

  it("tracks bans per tab and clears one on rejoin", async () => {
    const commands = fakeCommands();
    const store = createChannelStore(commands, memStorage());
    await store.select("a");
    await store.select("b");
    store.markBanned("id-a");
    expect(store.bannedIn("id-a")).toBe(true);
    expect(store.bannedIn("id-b")).toBe(false);
    await store.rejoin("id-a");
    expect(store.bannedIn("id-a")).toBe(false);
    expect(commands.log).toContain("rejoin id-a");
    store.markBanned("id-zzz");
    expect(store.bannedIn("id-zzz")).toBe(false);
  });

  it("counts unread for tabs off screen and clears on focus", async () => {
    const store = createChannelStore(fakeCommands(), memStorage());
    await store.select("a");
    await store.select("b");
    store.noteUnread("id-a");
    store.noteUnread("id-a");
    store.noteUnread("id-b");
    store.noteUnread("id-nope");
    expect(store.unread("id-a")).toBe(2);
    expect(store.unread("id-b")).toBe(0);
    await store.focus("id-a");
    expect(store.unread("id-a")).toBe(0);
  });
});

describe("pushRecent", () => {
  it("moves duplicates to the front and caps the list", () => {
    const base = Array.from({ length: MAX_RECENTS }, (_, i) => ({
      login: `u${i}`,
      display_name: `U${i}`,
      profile_image_url: "",
    }));
    const moved = pushRecent(base, base[3]!);
    expect(moved[0]!.login).toBe("u3");
    expect(moved).toHaveLength(MAX_RECENTS);
    const added = pushRecent(base, {
      login: "new",
      display_name: "New",
      profile_image_url: "",
    });
    expect(added[0]!.login).toBe("new");
    expect(added).toHaveLength(MAX_RECENTS);
    expect(added.some((r) => r.login === `u${MAX_RECENTS - 1}`)).toBe(false);
  });
});
