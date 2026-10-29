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

  it("stays open while another chat scrolls on its own", () => {
    const { chat } = setup();
    fireEvent.scroll(chat);
    expect(contextMenu()).not.toBeNull();
  });

  it("closes when what was right-clicked scrolls", () => {
    const { holder } = setup();
    fireEvent.scroll(holder);
    expect(contextMenu()).toBeNull();
  });
});
