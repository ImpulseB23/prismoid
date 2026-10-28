import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => "pasted"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
}));

const { openUrl } = await import("@tauri-apps/plugin-opener");
const { installContextMenus, fieldMenuItems } =
  await import("./appContextMenu");
const { contextMenu, closeContextMenu } =
  await import("../stores/contextMenuStore");

const labels = () =>
  (contextMenu()?.items ?? []).flatMap((i) =>
    i.kind === "item" ? [i.label] : [],
  );

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

function choose(label: string): void {
  const hit = contextMenu()?.items.find(
    (i) => i.kind === "item" && i.label === label,
  );
  if (hit?.kind !== "item") throw new Error(`no ${label}`);
  hit.onSelect();
}

function rightClick(target: Element): MouseEvent {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("app right-click", () => {
  let stop: () => void;
  beforeEach(() => {
    stop = installContextMenus();
  });
  afterEach(() => {
    stop();
    closeContextMenu();
    writeText.mockClear();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("blocks the browser menu where there is nothing to offer", () => {
    const div = document.body.appendChild(document.createElement("div"));
    expect(rightClick(div).defaultPrevented).toBe(true);
    expect(contextMenu()).toBeNull();
  });

  it("leaves a surface's own menu alone", () => {
    const div = document.body.appendChild(document.createElement("div"));
    div.addEventListener("contextmenu", (e) => e.preventDefault());
    rightClick(div);
    expect(contextMenu()).toBeNull();
  });

  it("offers edit actions in a text field", () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.value = "hello world";
    input.setSelectionRange(0, 5);
    rightClick(input);
    expect(labels()).toEqual(["Cut", "Copy", "Paste", "Select all"]);
  });

  it("offers only what fits a read-only field", () => {
    const input = document.createElement("input");
    input.value = "read me";
    input.readOnly = true;
    input.setSelectionRange(0, 4);
    const got = fieldMenuItems(input).flatMap((i) =>
      i.kind === "item" ? [i.label] : [],
    );
    expect(got).toEqual(["Copy", "Select all"]);
  });

  it("offers open and copy on a link", () => {
    const a = document.body.appendChild(document.createElement("a"));
    a.href = "https://example.com/";
    rightClick(a);
    expect(labels()).toEqual(["Open link", "Copy link"]);
  });

  it("pastes into the field as typing would", async () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.value = "ab";
    input.setSelectionRange(1, 1);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    const paste = fieldMenuItems(input).find(
      (i) => i.kind === "item" && i.label === "Paste",
    );
    if (paste?.kind !== "item") throw new Error("no paste");
    paste.onSelect();
    await vi.waitFor(() => expect(input.value).toBe("apastedb"));
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("cuts the selection to the clipboard", async () => {
    const area = document.body.appendChild(document.createElement("textarea"));
    area.value = "hello world";
    area.setSelectionRange(0, 6);
    rightClick(area);
    choose("Cut");
    await vi.waitFor(() => expect(area.value).toBe("world"));
    expect(writeText).toHaveBeenCalledWith("hello ");
  });

  it("copies the field selection", () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.value = "hello world";
    input.setSelectionRange(6, 11);
    rightClick(input);
    choose("Copy");
    expect(writeText).toHaveBeenCalledWith("world");
  });

  it("selects all in the field", () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.value = "hello";
    rightClick(input);
    choose("Select all");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
  });

  it("treats non-text inputs as plain surface", () => {
    const box = document.body.appendChild(document.createElement("input"));
    box.type = "checkbox";
    expect(rightClick(box).defaultPrevented).toBe(true);
    expect(contextMenu()).toBeNull();
  });

  it("opens and copies a link", () => {
    const a = document.body.appendChild(document.createElement("a"));
    a.href = "https://example.com/x";
    rightClick(a);
    choose("Open link");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/x");
    rightClick(a);
    choose("Copy link");
    expect(writeText).toHaveBeenCalledWith("https://example.com/x");
  });

  it("ignores non-web links", () => {
    const a = document.body.appendChild(document.createElement("a"));
    a.href = "mailto:me@example.com";
    expect(rightClick(a).defaultPrevented).toBe(true);
    expect(contextMenu()).toBeNull();
  });

  it("copies selected page text", () => {
    const p = document.body.appendChild(document.createElement("p"));
    p.textContent = "some chat text";
    window.getSelection()?.selectAllChildren(p);
    rightClick(p);
    expect(labels()).toEqual(["Copy"]);
    choose("Copy");
    expect(writeText).toHaveBeenCalledWith("some chat text");
  });

  it("blocks the menu for non-element targets", () => {
    const e = new MouseEvent("contextmenu", { cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(contextMenu()).toBeNull();
  });
});
