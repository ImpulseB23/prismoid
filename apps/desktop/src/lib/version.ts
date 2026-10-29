// Versions as people read them: a release with no patch number shows as
// "1.3", a patch release keeps it ("1.3.4"). Pre-releases and anything that
// is not plain x.y.z stay as they are. Keys, URLs and tags keep the full
// form; this is for display only.

export function displayVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || m[3] !== "0") return version;
  return `${m[1]}.${m[2]}`;
}

/** Orders plain x.y.z versions numerically, so 0.10.0 comes after 0.9.0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
