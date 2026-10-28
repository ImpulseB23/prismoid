// Prismoid is drawn to look right at 1.5x on a monitor Windows doesn't
// scale. A display Windows already scales only gets what's missing, so a
// laptop at 150% stays at 150% instead of ballooning to 225%. The zoom
// setting multiplies this base, and its 100% means "the intended size".
export const TARGET_UI_SCALE = 1.5;

export function baseZoom(osScale: number): number {
  return Math.max(1, TARGET_UI_SCALE / osScale);
}

/** The ladder value closest to `value`. */
export function snapTo(ladder: number[], value: number): number {
  return ladder.reduce((best, n) =>
    Math.abs(n - value) < Math.abs(best - value) ? n : best,
  );
}
