import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  createUpdateStore,
  type DownloadEvent,
  type PendingUpdate,
} from "./updateStore";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

function update(
  version: string,
  events: DownloadEvent[] = [{ event: "Finished" }],
): PendingUpdate {
  return {
    version,
    body: `notes for ${version}`,
    downloadAndInstall: async (onEvent) => {
      for (const e of events) onEvent?.(e);
    },
  };
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

  it("reports an available update and installs it with progress", async () => {
    const restarted = vi.fn(async () => {});
    const store = createUpdateStore(
      async () =>
        update("0.2.0", [
          { event: "Started", data: { contentLength: 100 } },
          { event: "Progress", data: { chunkLength: 40 } },
          { event: "Progress", data: { chunkLength: 60 } },
          { event: "Finished" },
        ]),
      restarted,
    );
    await store.check(true);
    expect(store.state()).toEqual({
      kind: "available",
      version: "0.2.0",
      notes: "notes for 0.2.0",
    });
    await store.install();
    expect(store.state()).toEqual({ kind: "ready", version: "0.2.0" });
    expect(restarted).toHaveBeenCalledOnce();
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
    expect(store.state()).toEqual({ kind: "error", message: "offline" });
  });

  it("surfaces an install failure", async () => {
    const store = createUpdateStore(
      async () => ({
        version: "0.2.0",
        downloadAndInstall: async () => {
          throw new Error("signature mismatch");
        },
      }),
      async () => {},
    );
    await store.check(true);
    await store.install();
    expect(store.state()).toEqual({
      kind: "error",
      message: "signature mismatch",
    });
  });

  it("checks after the launch delay and on the interval", async () => {
    const lookup = vi.fn(async () => null);
    const store = createUpdateStore(lookup);
    const stop = store.schedule();
    expect(lookup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(lookup).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("ignores a check while a download is running", async () => {
    let release!: () => void;
    const store = createUpdateStore(async () => ({
      version: "0.2.0",
      downloadAndInstall: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    }));
    await store.check(true);
    const installing = store.install();
    expect(store.state().kind).toBe("downloading");
    await store.check(true);
    expect(store.state().kind).toBe("downloading");
    release();
    await installing;
  });
});
