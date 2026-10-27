import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import UpdateScreen, { screenFor } from "./UpdateScreen";
import type { UpdateState } from "../stores/updateStore";

describe("screenFor", () => {
  it("is absent unless an install is under way or failed", () => {
    expect(screenFor({ kind: "idle" })).toBeNull();
    expect(
      screenFor({ kind: "available", version: "0.3.0", notes: null }),
    ).toBeNull();
    expect(
      screenFor({ kind: "error", message: "offline", during: "check" }),
    ).toBeNull();
  });

  it("reports progress, an unknown size, and the restart", () => {
    const base = {
      kind: "downloading",
      version: "0.3.0",
      received: 50,
    } as const;
    expect(screenFor({ ...base, total: 200 })).toMatchObject({
      detail: "Downloading 25%",
      progress: 25,
    });
    expect(screenFor({ ...base, total: null })).toMatchObject({
      detail: "Downloading",
      progress: null,
    });
    expect(screenFor({ kind: "ready", version: "0.3.0" })).toMatchObject({
      detail: "Restarting",
      progress: 100,
    });
  });
});

describe("UpdateScreen", () => {
  it("covers the app while installing", () => {
    const [state, setState] = createSignal<UpdateState>({ kind: "idle" });
    render(() => (
      <UpdateScreen state={state} onRetry={() => {}} onDismiss={() => {}} />
    ));
    expect(screen.queryByRole("status")).toBeNull();
    setState({ kind: "downloading", version: "0.3.0", received: 1, total: 4 });
    expect(screen.getByRole("status").textContent).toContain(
      "Updating prismoid",
    );
    expect(screen.getByRole("status").textContent).toContain("25%");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers retry and dismiss after a failed install", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const [state] = createSignal<UpdateState>({
      kind: "error",
      message: "signature mismatch",
      during: "install",
    });
    render(() => (
      <UpdateScreen state={state} onRetry={onRetry} onDismiss={onDismiss} />
    ));
    expect(screen.getByRole("alert").textContent).toContain(
      "signature mismatch",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
