import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { Channel } from "../lib/twitchChannel";
import type { Pane } from "../lib/pane";

vi.mock("../lib/chatSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatSession")>()),
  holdSession: (c: Channel) => ({ channelId: c.id, channel: c }),
  releaseSession: () => {},
}));

const { default: ChatPane } = await import("./ChatPane");
const { focusedPane, requirePane, usePane } = await import("../lib/pane");
const { focusedPaneId, panes, splitPane } =
  await import("../stores/layoutStore");
const { NOTICE_MS } = await import("../stores/noticeStore");

const channel = (id: string) =>
  ({ id, login: id, display_name: id }) as Channel;

// Two layout slots on the same channel, each pane handed out to the test
// so it can drive and inspect it.
function twoPanes() {
  if (panes().length < 2) splitPane("other");
  const [first, second] = panes().map((p) => p.id);
  const grabbed: Pane[] = [];
  const Grab = (props: { label: string }) => {
    grabbed.push(requirePane());
    return <button type="button">{props.label}</button>;
  };
  render(() => (
    <>
      <ChatPane slotId={first!} channel={channel("a")} focused={false}>
        <Grab label="in a" />
      </ChatPane>
      <ChatPane slotId={second!} channel={channel("a")} focused={false}>
        <Grab label="in b" />
      </ChatPane>
    </>
  ));
  return { panes: grabbed as [Pane, Pane], slots: [first!, second!] };
}

describe("ChatPane", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("gives each pane its own composer and thread on a shared channel", () => {
    const [a, b] = twoPanes().panes;
    expect(a.session().channel?.id).toBe("a");
    expect(b.session().channel?.id).toBe("a");
    a.composer.requestMention("kit");
    expect(a.composer.insertRequest()?.text).toBe("@kit");
    expect(b.composer.insertRequest()).toBeNull();
    a.composer.requestReply({
      message_id: "m",
      user_login: "kit",
      user_name: "Kit",
      body: "hi",
    });
    expect(b.composer.replyTarget()).toBeNull();
    a.composer.clearReply();
    expect(a.composer.replyTarget()).toBeNull();
    a.thread.open({ reply_to: "root", reply_parent: null } as never);
    expect(a.thread.root()).toBe("root");
    expect(b.thread.root()).toBeNull();
    a.thread.close();
    expect(a.thread.root()).toBeNull();
  });

  it("focuses whichever pane is clicked or typed in", () => {
    const {
      panes: [a, b],
      slots: [first, second],
    } = twoPanes();
    fireEvent.pointerDown(screen.getByText("in b"));
    expect(focusedPaneId()).toBe(second);
    expect(focusedPane()).toBe(b);
    fireEvent.focusIn(screen.getByText("in a"));
    expect(focusedPaneId()).toBe(first);
    expect(focusedPane()).toBe(a);
    cleanup();
    expect(focusedPane()).toBeUndefined();
  });

  it("clears a notice on its own", () => {
    vi.useFakeTimers();
    const [a] = twoPanes().panes;
    a.notice.notify("Timed out Kit");
    expect(a.notice.notice()).toBe("Timed out Kit");
    vi.advanceTimersByTime(NOTICE_MS);
    expect(a.notice.notice()).toBeNull();
  });

  it("has no pane outside one, and says so where one is required", () => {
    let outside: Pane | undefined = {} as Pane;
    const Probe = () => {
      outside = usePane();
      return null;
    };
    render(() => <Probe />);
    expect(outside).toBeUndefined();
    const Needs = () => {
      requirePane();
      return null;
    };
    expect(() => render(() => <Needs />)).toThrow(/outside a chat pane/);
  });
});
