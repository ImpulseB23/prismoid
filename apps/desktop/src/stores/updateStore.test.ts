import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_EVERY_MS,
  FOCUS_RECHECK_MS,
  LAUNCH_WINDOW_MS,
  createUpdateStore,
  type DownloadEvent,
} from "./updateStore";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

type OnEvent = (e: DownloadEvent) => void;

function update(
  version: string,
  events: DownloadEvent[] = [{ event: "Finished" }],
) {
  return {
    version,
    body: `notes for ${version}`,
    download: vi.fn(async (onEvent?: OnEvent) => {
      for (const e of events) onEvent?.(e);
    }),
    install: vi.fn(async () => {}),
  };
}

/** An update whose download waits until `finish` is called. */
function slowUpdate(version: string) {
  let finish!: () => void;
  let emit!: OnEvent;
  const u = update(version);
  u.download.mockImplementation(
    (onEvent?: OnEvent) =>
      new Promise<void>((resolve) => {
        emit = (e) => onEvent?.(e);
        finish = resolve;
      }),
  );
  return { u, finish: () => finish(), emit: (e: DownloadEvent) => emit(e) };
}

describe("updateStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("downloads a found update quietly, then installs without waiting", async () => {
    const restarted = vi.fn(async () => {});
    const u = update("0.2.0");
    const store = createUpdateStore(async () => u, restarted);
    await store.check(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.state()).toEqual({
      kind: "downloaded",
      version: "0.2.0",
      notes: "notes for 0.2.0",
    });
    await store.install();
    expect(u.download).toHaveBeenCalledOnce();
    expect(u.install).toHaveBeenCalledOnce();
    expect(store.state()).toEqual({ kind: "ready", version: "0.2.0" });
    expect(restarted).toHaveBeenCalledOnce();
  });

  it("starts the splash right before the installer, which runs even if it fails", async () => {
    const order: string[] = [];
    const u = update("0.2.0");
    u.install.mockImplementation(async () => {
      order.push("install");
    });
    const cover = vi.fn(async () => {
      order.push("splash");
    });
    const run = async () => {
      const store = createUpdateStore(
        async () => u,
        async () => {},
        Date.now,
        () => () => {},
        cover,
      );
      await store.check(false);
      await store.install();
    };
    await run();
    expect(order).toEqual(["splash", "install"]);

    cover.mockRejectedValueOnce(new Error("copy failed"));
    await run();
    expect(u.install).toHaveBeenCalledTimes(2);
  });

  it("asks the host for the splash in the current palette", async () => {
    const u = update("0.2.0");
    const store = createUpdateStore(
      async () => u,
      async () => {},
    );
    await store.check(false);
    await store.install();
    expect(invoke).toHaveBeenCalledWith("update_splash_start", {
      palette: expect.stringMatching(/^(light|dark)$/),
    });
  });

  it("waits on the quiet download when installed early, with progress", async () => {
    const { u, finish, emit } = slowUpdate("0.2.0");
    const store = createUpdateStore(
      async () => u,
      async () => {},
    );
    await store.check(false);
    expect(store.state().kind).toBe("available");
    emit({ event: "Started", data: { contentLength: 100 } });
    emit({ event: "Progress", data: { chunkLength: 40 } });
    const installing = store.install();
    expect(store.state()).toEqual({
      kind: "downloading",
      version: "0.2.0",
      received: 40,
      total: 100,
    });
    emit({ event: "Progress", data: { chunkLength: 60 } });
    expect(store.state()).toMatchObject({ received: 100 });
    finish();
    await installing;
    expect(u.download).toHaveBeenCalledOnce();
    expect(store.state().kind).toBe("ready");
  });

  it("does not download the same version twice", async () => {
    const u = update("0.2.0");
    const store = createUpdateStore(async () => u);
    await store.check(false);
    await vi.advanceTimersByTimeAsync(0);
    await store.check(true);
    expect(u.download).toHaveBeenCalledOnce();
    expect(store.state().kind).toBe("downloaded");
  });

  it("records when the app is current", async () => {
    const store = createUpdateStore(async () => null);
    await store.check(true);
    expect(store.state().kind).toBe("none");
  });

  it("shows errors only for manual checks", async () => {
    const store = createUpdateStore(async () => {
      throw new Error("offline");
    });
    await store.check(false);
    expect(store.state()).toEqual({ kind: "idle" });
    await store.check(true);
    expect(store.state()).toEqual({
      kind: "error",
      message: "offline",
      during: "check",
    });
  });

  it("stays available when the quiet download fails, and retries on install", async () => {
    const u = update("0.2.0");
    u.download.mockRejectedValueOnce(new Error("reset"));
    const store = createUpdateStore(
      async () => u,
      async () => {},
    );
    await store.check(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.state().kind).toBe("available");
    await store.install();
    expect(u.download).toHaveBeenCalledTimes(2);
    expect(store.state().kind).toBe("ready");
  });

  it("surfaces an install failure and downloads again on retry", async () => {
    const u = update("0.2.0");
    u.install.mockRejectedValueOnce(new Error("signature mismatch"));
    const store = createUpdateStore(
      async () => u,
      async () => {},
    );
    await store.check(true);
    await vi.advanceTimersByTimeAsync(0);
    await store.install();
    expect(store.state()).toEqual({
      kind: "error",
      message: "signature mismatch",
      during: "install",
    });
    await store.install();
    expect(u.download).toHaveBeenCalledTimes(2);
    expect(store.state().kind).toBe("ready");
  });

  it("checks at launch and on the interval", async () => {
    const lookup = vi.fn(async () => null);
    const store = createUpdateStore(lookup);
    const stop = store.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(lookup).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("checks again on focus once the last check is stale", async () => {
    const lookup = vi.fn(async () => null);
    let focus!: () => void;
    const unwatch = vi.fn();
    const store = createUpdateStore(lookup, undefined, undefined, (cb) => {
      focus = cb;
      return unwatch;
    });
    const stop = store.schedule();
    await vi.advanceTimersByTimeAsync(0);
    focus();
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FOCUS_RECHECK_MS);
    focus();
    expect(lookup).toHaveBeenCalledTimes(2);
    stop();
    expect(unwatch).toHaveBeenCalledOnce();
  });

  it("ignores a check while an install is downloading", async () => {
    const { u, finish } = slowUpdate("0.2.0");
    const store = createUpdateStore(
      async () => u,
      async () => {},
    );
    await store.check(true);
    const installing = store.install();
    expect(store.state().kind).toBe("downloading");
    await store.check(true);
    expect(store.state().kind).toBe("downloading");
    finish();
    await installing;
  });

  it("installs on its own when the launch check finds an update", async () => {
    const restarted = vi.fn(async () => {});
    const store = createUpdateStore(async () => update("0.3.0"), restarted);
    const stop = store.schedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.state()).toEqual({ kind: "ready", version: "0.3.0" });
    expect(restarted).toHaveBeenCalledOnce();
    stop();
  });

  it("only downloads quietly when the launch check answers late", async () => {
    const store = createUpdateStore(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(update("0.3.0")), LAUNCH_WINDOW_MS + 1),
        ),
    );
    const stop = store.schedule();
    await vi.advanceTimersByTimeAsync(LAUNCH_WINDOW_MS + 1);
    expect(store.state()).toMatchObject({
      kind: "downloaded",
      version: "0.3.0",
    });
    stop();
  });

  it("goes back to available when a failed install is dismissed", async () => {
    const u = update("0.3.0");
    u.install.mockRejectedValueOnce(new Error("disk full"));
    const store = createUpdateStore(
      async () => u,
      async () => {},
    );
    await store.check(true);
    await store.install();
    expect(store.state().kind).toBe("error");
    store.dismiss();
    expect(store.state()).toEqual({
      kind: "available",
      version: "0.3.0",
      notes: "notes for 0.3.0",
    });
  });
});
