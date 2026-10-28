// Warms the image cache so a window opens with its pictures already drawn.
// Gives up after `capMs` so one slow image cannot hold the window shut.

export function preloadImages(
  urls: Iterable<string>,
  capMs = 1500,
): Promise<void> {
  const loads = [...new Set(urls)].filter(Boolean).map((url) => {
    const img = new Image();
    img.src = url;
    return img.decode().catch(() => {});
  });
  if (loads.length === 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.all(loads).then(() => {}),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, capMs))),
  ]).finally(() => clearTimeout(timer));
}
