import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./App", () => ({ default: () => <p>main app</p> }));
vi.mock("./StreamManagerWindow", () => ({
  default: () => <p>stream manager</p>,
}));

const { boot } = await import("./boot");

describe("boot", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mount(label: string): Promise<string> {
    const root = document.createElement("div");
    document.body.append(root);
    await boot(label, root);
    return root.textContent ?? "";
  }

  it("renders the stream manager in its window", async () => {
    expect(await mount("stream-manager")).toBe("stream manager");
  });

  it("renders the app for every other window", async () => {
    expect(await mount("main")).toBe("main app");
  });
});
