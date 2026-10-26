// /download/<platform> sends the visitor straight to the newest installer.
// The release workflow uploads the Windows installer under a fixed name, so
// GitHub's latest-release redirect resolves it without an API call. Before
// the first release, or for a platform without an installer yet, the
// visitor lands on the releases page instead.

import type { APIEvent } from "@solidjs/start/server";

const RELEASES = "https://github.com/ImpulseB23/Prismoid/releases";

const INSTALLERS: Record<string, string> = {
  windows: `${RELEASES}/latest/download/Prismoid-Setup-x64.exe`,
};

export async function GET({ params }: APIEvent) {
  const installer = INSTALLERS[params.platform ?? ""];
  if (installer && (await published(installer))) {
    return Response.redirect(installer, 302);
  }
  return Response.redirect(`${RELEASES}/latest`, 302);
}

// GitHub answers a latest-release asset with a redirect to its storage and
// a missing one with 404, so the status alone says whether it exists.
async function published(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual" });
    return res.status >= 300 && res.status < 400;
  } catch {
    return false;
  }
}
