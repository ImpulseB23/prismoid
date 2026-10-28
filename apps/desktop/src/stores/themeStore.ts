// Turns the theme setting into the palette on screen. "system" follows the
// Windows light/dark switch live; the stylesheet keys off data-theme on <html>.

import { createSignal } from "solid-js";
import { settings, type Theme } from "./settingsStore";
import logoOnDark from "../assets/logo.svg";
import logoOnLight from "../assets/logo-on-light.svg";

export type Palette = Exclude<Theme, "system">;

export function resolvePalette(theme: Theme, systemDark: boolean): Palette {
  if (theme !== "system") return theme;
  return systemDark ? "dark" : "light";
}

const query =
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
const [systemDark, setSystemDark] = createSignal(query?.matches ?? true);
query?.addEventListener("change", (e) => setSystemDark(e.matches));

export const palette = () => resolvePalette(settings().theme, systemDark());
export const isLight = () => palette() === "light";
export const logo = () => (isLight() ? logoOnLight : logoOnDark);
