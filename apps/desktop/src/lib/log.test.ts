import { describe as suite, expect, it, vi } from "vitest";
import { describe, forwardConsole, getSupportBundle, openLogDir } from "./log";

const invoke = vi.fn<(cmd: string) => Promise<unknown>>(async () => {});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  warn: vi.fn(async () => {}),
  error: vi.fn(async () => {}),
}));

suite("describe", () => {
  it("renders strings, errors and data", () => {
    expect(describe("plain")).toBe("plain");
    const err = new Error("boom");
    expect(describe(err)).toBe(err.stack);
    const bare = new Error("no stack");
    bare.stack = undefined;
    expect(describe(bare)).toBe("Error: no stack");
    expect(describe({ kind: "oauth", message: "nope" })).toBe(
      '{"kind":"oauth","message":"nope"}',
    );
    expect(describe(undefined)).toBe("undefined");
  });

  it("falls back for values json cannot take", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(describe(loop)).toBe("[object Object]");
  });
});

const sink = (impl: (message: string) => Promise<void> = async () => {}) =>
  vi.fn<(message: string) => Promise<void>>(impl);

suite("forwardConsole", () => {
  it("keeps the console call and sends the joined message", () => {
    const warnOut = vi.fn();
    const errorOut = vi.fn();
    const sinks = { warn: sink(), error: sink() };
    const target = { warn: warnOut, error: errorOut };
    forwardConsole(target, sinks);

    target.error("update check", new Error("offline"));
    expect(errorOut).toHaveBeenCalledWith("update check", expect.any(Error));
    expect(sinks.error).toHaveBeenCalledOnce();
    expect(sinks.error.mock.calls[0][0]).toMatch(
      /^update check Error: offline/,
    );

    target.warn("slow", { ms: 1200 });
    expect(warnOut).toHaveBeenCalledOnce();
    expect(sinks.warn).toHaveBeenCalledWith('slow {"ms":1200}');
  });

  it("swallows a failing sink", async () => {
    const sinks = {
      warn: sink(),
      error: sink(async () => {
        throw new Error("no runtime");
      }),
    };
    const target = { warn: vi.fn(), error: vi.fn() };
    forwardConsole(target, sinks);
    expect(() => target.error("x")).not.toThrow();
    await Promise.resolve();
  });
});

it("opens the log folder through the host", async () => {
  await openLogDir();
  expect(invoke).toHaveBeenCalledWith("open_log_dir");
});

it("returns the support bundle from the host", async () => {
  invoke.mockResolvedValueOnce("Prismoid 0.6.0\n");
  await expect(getSupportBundle()).resolves.toBe("Prismoid 0.6.0\n");
  expect(invoke).toHaveBeenLastCalledWith("support_bundle");
});
