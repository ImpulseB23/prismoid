// Versions as people read them: a release with no patch number shows as
// "1.3", a patch release keeps it ("1.3.4"). Pre-releases and anything that
// is not plain x.y.z stay as they are. Keys, URLs and tags keep the full
// form; this is for display only.

export function displayVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || m[3] !== "0") return version;
  return `${m[1]}.${m[2]}`;
}
