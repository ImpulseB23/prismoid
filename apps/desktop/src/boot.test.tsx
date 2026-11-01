import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./App", () => ({ default: () => <p>main app</p> }));
vi.mock("./UserCardWindow", () => ({ default: () => <p>user card</p> }));
vi.mock("./VideoWindow", () => ({ default: () => <p>video</p> }));
const move = {
  exportOldStorage: vi.fn(async () => {}),
  importOldStorage: vi.fn(async () => {}),
};
vi.mock("./lib/storageMove", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/storageMove")>()),
  ...move,
}));

const { boot } = await import("./boot");

describe("boot", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    move.exportOldStorage.mockClear();
    move.importOldStorage.mockClear();
  });

  async function mount(label: string): Promise<string> {
    const root = document.createElement("div");
    document.body.append(root);
    await boot(label, root);
    return root.textContent ?? "";
  }

  it("renders the card for user card windows", async () => {
    expect(await mount("user-card-3")).toBe("user card");
    expect(move.importOldStorage).not.toHaveBeenCalled();
  });

  it("renders the player for pop-out video windows", async () => {
    expect(await mount("video-caedrel")).toBe("video");
    expect(move.importOldStorage).not.toHaveBeenCalled();
  });

  it("renders only the update screen in the update splash", async () => {
    history.replaceState(null, "", "/?palette=light");
    const text = await mount("update-splash");
    expect(text).toContain("Updating prismoid");
    expect(text).toContain("Installing");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(move.importOldStorage).not.toHaveBeenCalled();

    // The host marks a failed install while it reopens the app.
    location.hash = "failed";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(document.body.textContent).toContain("Update did not finish");
    history.replaceState(null, "", "/");
  });

  it("renders the app for every other window", async () => {
    expect(await mount("main")).toBe("main app");
    expect(move.importOldStorage).toHaveBeenCalledOnce();
  });

  it("still renders the app when the storage move fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    move.importOldStorage.mockRejectedValueOnce(new Error("timed out"));
    expect(await mount("main")).toBe("main app");
    expect(error).toHaveBeenCalledWith("storage move", expect.any(Error));
    error.mockRestore();
  });

  it("only hands storage over in the storage move window", async () => {
    expect(await mount("storage-move")).toBe("");
    expect(move.exportOldStorage).toHaveBeenCalledOnce();
  });
});
