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
const { NOTICE_MS } = await import("../stores/noticeStore");

const channel = (id: string) =>
  ({ id, login: id, display_name: id }) as Channel;

// Hands each pane out to the test so it can drive and inspect it.
function twoPanes() {
  const panes: Pane[] = [];
  const Grab = (props: { label: string }) => {
    panes.push(requirePane());
    return <button type="button">{props.label}</button>;
  };
  render(() => (
    <>
      <ChatPane channel={channel("a")}>
        <Grab label="in a" />
      </ChatPane>
      <ChatPane channel={channel("a")}>
        <Grab label="in b" />
      </ChatPane>
    </>
  ));
  return panes as [Pane, Pane];
}

describe("ChatPane", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("gives each pane its own composer and thread on a shared channel", () => {
    const [a, b] = twoPanes();
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

  it("focuses the first pane, then whichever is clicked or typed in", () => {
    const [a, b] = twoPanes();
    expect(focusedPane()).toBe(a);
    fireEvent.pointerDown(screen.getByText("in b"));
    expect(focusedPane()).toBe(b);
    fireEvent.focusIn(screen.getByText("in a"));
    expect(focusedPane()).toBe(a);
    cleanup();
    expect(focusedPane()).toBeNull();
  });

  it("clears a notice on its own", () => {
    vi.useFakeTimers();
    const [a] = twoPanes();
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
