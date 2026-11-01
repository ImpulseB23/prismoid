import { describe, expect, it, vi } from "vitest";
import type { ScreenView } from "../components/UpdateScreen";
import type { DownloadEvent, PendingUpdate } from "../stores/updateStore";
import { CHECKING, launchUpdate } from "./launchUpdate";

function deps(update: PendingUpdate | null | Error) {
  const views: ScreenView[] = [];
  const order: string[] = [];
  return {
    views,
    order,
    deps: {
      check: vi.fn(async () => {
        if (update instanceof Error) throw update;
        return update;
      }),
      cover: vi.fn(async () => {
        order.push("cover");
      }),
      open: vi.fn(async () => {
        order.push("open");
      }),
      show: (v: ScreenView) => views.push(v),
    },
  };
}

function update(events: DownloadEvent[]): PendingUpdate & {
  install: ReturnType<typeof vi.fn>;
} {
  return {
    version: "0.11.0",
    download: async (onEvent) => {
      for (const e of events) onEvent?.(e);
    },
    install: vi.fn(async () => {}),
  };
}

describe("launchUpdate", () => {
  it("opens the app when there is nothing to install", async () => {
    const d = deps(null);
    await launchUpdate(d.deps);
    expect(d.order).toEqual(["open"]);
    expect(d.views).toEqual([]);
    expect(CHECKING.detail).toBe("Checking for updates");
  });

  it("opens the app when the check fails or times out", async () => {
    const d = deps(new Error("offline"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await launchUpdate(d.deps);
    expect(d.order).toEqual(["open"]);
    error.mockRestore();
  });

  it("downloads with progress, then hands the install to the splash", async () => {
    const u = update([
      { event: "Started", data: { contentLength: 200 } },
      { event: "Progress", data: { chunkLength: 50 } },
      { event: "Progress", data: { chunkLength: 150 } },
      { event: "Finished" },
    ]);
    u.install.mockImplementation(async () => {
      d.order.push("install");
    });
    const d = deps(u);
    await launchUpdate(d.deps);
    expect(d.views.map((v) => v.detail)).toEqual([
      "Downloading",
      "Downloading 0%",
      "Downloading 25%",
      "Downloading 100%",
      "Downloading 100%",
      "Installing",
    ]);
    expect(d.order).toEqual(["cover", "install"]);
  });

  it("opens the app when the download or install fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const u = update([]);
    u.download = async () => {
      throw new Error("signature mismatch");
    };
    const d = deps(u);
    await launchUpdate(d.deps);
    expect(d.order).toEqual(["open"]);

    const broken = update([{ event: "Finished" }]);
    broken.install.mockRejectedValueOnce(new Error("disk full"));
    const again = deps(broken);
    again.deps.cover.mockRejectedValueOnce(new Error("copy failed"));
    await launchUpdate(again.deps);
    expect(again.order).toEqual(["open"]);
    expect(broken.install).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
