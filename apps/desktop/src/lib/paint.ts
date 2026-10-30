// Turns a 7TV paint into the style of a painted username. The fill changes
// through background-clip: text (see .name--painted), so font, weight and
// width stay exactly what Pretext measured. Mirrors the 7TV extension's
// src/composable/useCosmetics.ts: transparent stops show the chat color,
// shadows become drop-shadow filters.

import type { JSX } from "solid-js";
import type { Paint } from "../stores/paintStore";
import { normalizeUserColor, type NameContrast } from "./messageStyle";

/**
 * On the light palette every stop goes through the same darkening as plain
 * name colors so pale paints stay readable; alpha is kept.
 */
function stopColor(color: string, contrast: NameContrast): string {
  if (contrast !== "light") return color;
  return normalizeUserColor(color.slice(0, 7), contrast) + color.slice(7);
}

function background(paint: Paint, contrast: NameContrast): string | undefined {
  if (paint.function === "URL") {
    if (!paint.image_url) return undefined;
    let url: URL;
    try {
      url = new URL(paint.image_url);
    } catch {
      return undefined;
    }
    // href percent-encodes quotes, so it is safe inside url("").
    return url.protocol === "https:" ? `url("${url.href}")` : undefined;
  }
  if (paint.stops.length === 0) return undefined;
  const stops = paint.stops.map(
    (s) => `${stopColor(s.color, contrast)} ${+(s.at * 100).toFixed(3)}%`,
  );
  const repeat = paint.repeat ? "repeating-" : "";
  const head =
    paint.function === "LINEAR_GRADIENT"
      ? `${repeat}linear-gradient(${paint.angle}deg`
      : `${repeat}radial-gradient(${paint.shape ?? "circle"}`;
  return `${head}, ${stops.join(", ")})`;
}

/**
 * Style for a username: the readable chat color, plus the paint's fill and
 * shadows when it has one that renders. `painted` says whether to add the
 * `name--painted` class.
 */
export function nameStyle(
  color: string | null | undefined,
  paint: Paint | undefined,
  contrast: NameContrast,
): { style: JSX.CSSProperties; painted: boolean } {
  const image = paint && background(paint, contrast);
  if (!paint || !image) {
    return {
      style: { color: normalizeUserColor(color, contrast) },
      painted: false,
    };
  }
  const style: JSX.CSSProperties = {
    color: normalizeUserColor(paint.color?.slice(0, 7) ?? color, contrast),
    "background-image": image,
  };
  if (paint.shadows.length > 0) {
    style.filter = paint.shadows
      .map((s) => `drop-shadow(${s.x}px ${s.y}px ${s.radius}px ${s.color})`)
      .join(" ");
  }
  return { style, painted: true };
}
