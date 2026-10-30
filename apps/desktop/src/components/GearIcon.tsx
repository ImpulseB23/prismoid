import type { Component } from "solid-js";

/** Outline of an eight-tooth gear centred in a 16 px box. */
const GEAR_PATH = (() => {
  const teeth = 8;
  const outer = 7;
  const inner = 5.4;
  const steps = teeth * 4;
  const parts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const r = i % 4 < 2 ? outer : inner;
    const angle = ((i - 0.5) / steps) * Math.PI * 2;
    const x = (8 + r * Math.cos(angle)).toFixed(2);
    const y = (8 + r * Math.sin(angle)).toFixed(2);
    parts.push(`${i === 0 ? "M" : "L"}${x} ${y}`);
  }
  return `${parts.join(" ")} Z`;
})();

const GearIcon: Component<{ size?: number }> = (props) => (
  <svg
    class="gear-icon"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path
      d={GEAR_PATH}
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linejoin="round"
    />
    <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.3" />
  </svg>
);

export default GearIcon;
