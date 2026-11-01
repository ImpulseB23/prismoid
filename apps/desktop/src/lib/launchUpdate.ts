// What the startup window does, the way Discord starts: look for an update
// before the app shows, and when there is one, download it with its
// progress on screen and install it, the update splash covering the
// install once this process quits. No update, no network, or anything
// failing on the way opens the app as usual.

import type { PendingUpdate } from "../stores/updateStore";
import type { ScreenView } from "../components/UpdateScreen";

/** Long enough for a slow connection, short enough not to hold up a start. */
export const LAUNCH_CHECK_TIMEOUT_MS = 5_000;

export interface LaunchDeps {
  check: () => Promise<PendingUpdate | null>;
  /** Starts the update splash that covers the install. */
  cover: () => Promise<void>;
  /** Closes the startup window and shows the app. */
  open: () => Promise<void>;
  show: (view: ScreenView) => void;
}

export const CHECKING: ScreenView = {
  title: "Starting prismoid",
  detail: "Checking for updates",
  progress: null,
  failed: false,
};

export async function launchUpdate(deps: LaunchDeps): Promise<void> {
  let update: PendingUpdate | null;
  try {
    update = await deps.check();
  } catch (err) {
    console.error("launch update check", err);
    return deps.open();
  }
  if (!update) return deps.open();
  try {
    let received = 0;
    let total: number | null = null;
    const downloading = () => {
      const progress = total ? Math.round((received / total) * 100) : null;
      deps.show({
        title: "Updating prismoid",
        detail: progress === null ? "Downloading" : `Downloading ${progress}%`,
        progress,
        failed: false,
      });
    };
    downloading();
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
      }
      downloading();
    });
    deps.show({
      title: "Updating prismoid",
      detail: "Installing",
      progress: null,
      failed: false,
    });
    await deps
      .cover()
      .catch((err: unknown) => console.error("update splash", err));
    // Quits this process; the splash and then the new version take over.
    await update.install();
  } catch (err) {
    console.error("launch update", err);
    await deps.open();
  }
}
