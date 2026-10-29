import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

const { default: ContextMenu } = await import("./ContextMenu");
const { closeContextMenu, contextMenu, item, openContextMenu } =
  await import("../stores/contextMenuStore");

// A right-click on `target` inside `holder`, next to a chat that scrolls on
// its own.
function setup() {
  const holder = document.createElement("div");
  const target = document.createElement("span");
  const chat = document.createElement("div");
  holder.append(target);
  document.body.append(holder, chat);
  render(() => <ContextMenu />);
  openContextMenu(
    {
      clientX: 10,
      clientY: 10,
      target,
      preventDefault: () => {},
    },
    [item("Open in split", () => {})],
  );
  return { holder, chat };
}

describe("ContextMenu", () => {
  afterEach(() => {
    closeContextMenu();
    cleanup();
    document.body.innerHTML = "";
  });

  it("stays open while chat scrolls on its own", () => {
    const { holder, chat } = setup();
    fireEvent.scroll(chat);
    fireEvent.scroll(holder);
    expect(contextMenu()).not.toBeNull();
  });

  it("closes when the user scrolls, but not inside the menu", () => {
    const { holder } = setup();
    fireEvent.wheel(document.querySelector(".ctx")!);
    expect(contextMenu()).not.toBeNull();
    fireEvent.wheel(holder);
    expect(contextMenu()).toBeNull();
  });
});
