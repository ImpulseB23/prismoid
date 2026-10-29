// Line icons for the landing page, drawn here so the page loads nothing
// from outside. All share one 24-unit grid and stroke so they read as one
// set at any size.

import type { JSX } from "solid-js";

type Name =
  | "feather"
  | "bolt"
  | "shield"
  | "direct"
  | "history"
  | "gavel"
  | "tabs"
  | "smile"
  | "browser"
  | "layers"
  | "cast"
  | "sliders"
  | "puzzle"
  | "laptop"
  | "poll"
  | "key";

const PATHS: Record<Name, JSX.Element> = {
  feather: (
    <>
      <path d="M20.2 3.8a5 5 0 0 0-7 0L4 13v7h7l9.2-9.2a5 5 0 0 0 0-7z" />
      <path d="M16 8 2 22" />
      <path d="M17.5 15H9" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  shield: (
    <>
      <path d="M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  direct: (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <path d="M7.5 12h9" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  gavel: (
    <>
      <path d="m14 13-7.5 7.5a1.5 1.5 0 0 1-2-2L12 11" />
      <path d="m16 16 6-6" />
      <path d="m8 8 6-6" />
      <path d="m9 7 8 8" />
      <path d="m21 11-8-8" />
    </>
  ),
  tabs: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M3 10h18" />
      <path d="M9 5v5" />
      <path d="M15 5v5" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5s1.2 2 3.5 2 3.5-2 3.5-2" />
      <path d="M9 9.5h.01" />
      <path d="M15 9.5h.01" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M6.5 6.5h.01" />
      <path d="M9.5 6.5h.01" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  cast: (
    <>
      <path d="M2 16.5a4 4 0 0 1 4 4" />
      <path d="M2 12.5a8 8 0 0 1 8 8" />
      <path d="M2 8.5V7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7" />
      <path d="M2 20.5h.01" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <path d="M4 18h12" />
      <path d="M20 18h.01" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  puzzle: (
    <path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3V4z" />
  ),
  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M2 19h20" />
    </>
  ),
  poll: (
    <>
      <path d="M5 20v-8" />
      <path d="M12 20V4" />
      <path d="M19 20v-12" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 9.3-9.3" />
      <path d="m16 7 3 3" />
      <path d="m19 4 2 2" />
    </>
  ),
};

export default function Icon(props: { name: Name; class?: string }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]}
    </svg>
  );
}
