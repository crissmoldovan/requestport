/**
 * RequestPort's mark: an arrow handing a request over, and two evenly spaced echoes
 * carrying it into the space that receives it (brand/requestport-icon.svg, without its
 * tile). Drawn in the theme's accent, so it follows every theme and mode.
 */
export function RequestPortMark({ size = 16 }: { size?: number }) {
  const accent = "var(--cue-accent, #e66a45)";
  const echo = (tip: number, opacity: number) => (
    <path
      d={`M${tip - 12} 14.5 L${tip} 32 L${tip - 12} 49.5`}
      fill="none"
      opacity={opacity}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={3}
      style={{ stroke: accent }}
    />
  );
  return (
    <svg
      aria-hidden="true"
      height={size}
      style={{ flexShrink: 0 }}
      viewBox="12 12 40 40"
      width={size}
    >
      <path
        d="M14 20.5 Q14 14 20.5 14 H22 L34 32 L22 50 H20.5 Q14 50 14 43.5 Z"
        style={{ fill: accent }}
      />
      {echo(40, 0.55)}
      {echo(47.8, 0.25)}
    </svg>
  );
}
