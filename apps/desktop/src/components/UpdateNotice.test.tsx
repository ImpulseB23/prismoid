import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import UpdateNotice, { noticeFor } from "./UpdateNotice";
import type { UpdateState } from "../stores/updateStore";

describe("noticeFor", () => {
  it("stays quiet until something needs the user", () => {
    expect(noticeFor({ kind: "idle" })).toBeNull();
    expect(noticeFor({ kind: "checking" })).toBeNull();
    expect(noticeFor({ kind: "none", checkedAt: 1 })).toBeNull();
  });

  it("reports download progress when the size is known", () => {
    const base = {
      kind: "downloading",
      version: "0.2.0",
      received: 25,
    } as const;
    expect(noticeFor({ ...base, total: 100 })?.text).toBe("Downloading 25%");
    expect(noticeFor({ ...base, total: null })?.text).toBe("Downloading");
  });
});

describe("UpdateNotice", () => {
  it("offers to install a ready update", () => {
    const onInstall = vi.fn();
    const [state, setState] = createSignal<UpdateState>({ kind: "idle" });
    render(() => <UpdateNotice state={state} onInstall={onInstall} />);
    expect(screen.queryByRole("status")).toBeNull();

    setState({ kind: "available", version: "0.2.0", notes: null });
    expect(screen.getByRole("status").textContent).toContain(
      "Version 0.2.0 is ready.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Install and restart" }),
    );
    expect(onInstall).toHaveBeenCalledOnce();

    setState({ kind: "ready", version: "0.2.0" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Restarting");
  });

  it("lets a failed install be retried", () => {
    const onInstall = vi.fn();
    const [state] = createSignal<UpdateState>({
      kind: "error",
      message: "signature mismatch",
    });
    render(() => <UpdateNotice state={state} onInstall={onInstall} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "signature mismatch",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onInstall).toHaveBeenCalledOnce();
  });
});
