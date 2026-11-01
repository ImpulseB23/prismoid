import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import UpdateButton from "./UpdateButton";
import type { UpdateState } from "../stores/updateStore";

describe("UpdateButton", () => {
  afterEach(cleanup);

  it("shows as soon as an update is found and installs on click", () => {
    const [state, setState] = createSignal<UpdateState>({ kind: "checking" });
    const onInstall = vi.fn();
    render(() => <UpdateButton state={state()} onInstall={onInstall} />);
    expect(screen.queryByRole("button")).toBeNull();

    setState({ kind: "available", version: "0.11.0", notes: null });
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.11" }));
    expect(onInstall).toHaveBeenCalledOnce();

    setState({ kind: "downloaded", version: "0.11.0", notes: null });
    expect(
      screen.getByRole("button", { name: "Restart to update to 0.11" }),
    ).toBeTruthy();

    setState({ kind: "downloading", version: "0.11.0", received: 1, total: 2 });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
