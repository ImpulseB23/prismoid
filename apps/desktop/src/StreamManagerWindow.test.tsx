import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import type { AuthStatus } from "./lib/twitchAuth";
import type { ChatEvent } from "./lib/chatEvents";
import type { ChannelInfo, Poll } from "./lib/streamManager";

const invoke = vi.fn<(cmd: string) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));

let emit: ((events: ChatEvent[]) => void) | undefined;
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_name: string, handler: (e: { payload: ChatEvent[] }) => void) => {
      emit = (payload) => handler({ payload });
      return unlisten;
    },
  ),
}));

const auth = {
  getAuthStatus: vi.fn<() => Promise<AuthStatus>>(),
  onAuthChanged: vi.fn(async () => () => {}),
};
vi.mock("./lib/twitchAuth", () => auth);

const ready = vi.fn(async () => {});
vi.mock("./lib/streamManagerWindow", () => ({
  streamManagerReady: () => ready(),
}));
vi.mock("./lib/appContextMenu", () => ({
  installContextMenus: () => () => {},
}));
vi.mock("./stores/windowStore", () => ({
  trackWindowChrome: async () => () => {},
  customChrome: () => false,
  maximized: () => false,
}));

const { default: StreamManagerWindow } = await import("./StreamManagerWindow");
const { currentPoll } = await import("./stores/streamManagerStore");
const { setAuthStatus } = await import("./stores/authStore");

const signedIn = (over: Partial<AuthStatus> = {}): AuthStatus => ({
  state: "logged_in",
  login: "me",
  user_id: "7",
  missing_scopes: [],
  enabled_scope_groups: [],
  ...over,
});

const info: ChannelInfo = {
  broadcaster_id: "7",
  title: "ranked grind",
  game_id: "",
  game_name: "",
  broadcaster_language: "en",
  tags: [],
  content_classification_labels: [],
  is_branded_content: false,
};

const poll: Poll = {
  id: "p1",
  channel_id: "7",
  title: "Pizza or ramen?",
  choices: [],
  channel_points_voting_enabled: false,
  channel_points_per_vote: 0,
  status: "active",
  started_at: 1,
  ends_at: 2,
  ended_at: null,
};

describe("StreamManagerWindow", () => {
  beforeEach(() => {
    emit = undefined;
    invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case "twitch_get_channel_info":
          return info;
        case "twitch_get_stream_info":
          return {
            is_live: true,
            title: info.title,
            game_name: "",
            viewer_count: 3,
            started_at: new Date().toISOString(),
          };
        case "twitch_get_ad_schedule":
          return {
            next_ad_at: null,
            last_ad_at: null,
            duration: 60,
            preroll_free_time: 0,
            snooze_count: 3,
            snooze_refresh_at: null,
          };
        default:
          return null;
      }
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setAuthStatus(null);
  });

  it("asks to sign in over in the main window", async () => {
    auth.getAuthStatus.mockResolvedValue({ state: "logged_out" });
    render(() => <StreamManagerWindow />);
    expect(
      await screen.findByText(/Sign in to Twitch in the main Prismoid window/),
    ).toBeTruthy();
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalledWith("twitch_get_channel_info");
  });

  it("loads the stream and the sections for the signed-in user", async () => {
    auth.getAuthStatus.mockResolvedValue(signedIn());
    render(() => <StreamManagerWindow />);
    expect(
      await screen.findByText("Live", { selector: ".sm-status" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Live" }).getAttribute("aria-current"),
    ).toBe("page");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("twitch_get_channel_info"),
    );
    expect(invoke).not.toHaveBeenCalledWith("twitch_get_ad_schedule");
  });

  it("applies poll updates from the host", async () => {
    auth.getAuthStatus.mockResolvedValue(signedIn());
    render(() => <StreamManagerWindow />);
    await waitFor(() => expect(emit).toBeDefined());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("twitch_get_poll"));
    emit!([{ ...poll, kind: "poll_update" }]);
    expect(currentPoll()?.id).toBe("p1");
    cleanup();
    expect(unlisten).toHaveBeenCalled();
  });

  it("tracks the ad schedule once ads are on", async () => {
    auth.getAuthStatus.mockResolvedValue(
      signedIn({ enabled_scope_groups: ["ads"] }),
    );
    render(() => <StreamManagerWindow />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("twitch_get_ad_schedule"),
    );
  });

  it("asks for a reconnect when the grant predates the stream manager", async () => {
    auth.getAuthStatus.mockResolvedValue(
      signedIn({ missing_scopes: ["channel:manage:polls"] }),
    );
    render(() => <StreamManagerWindow />);
    expect(
      await screen.findByText(
        "The stream manager needs a new Twitch permission",
      ),
    ).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("twitch_get_channel_info");
  });
});
