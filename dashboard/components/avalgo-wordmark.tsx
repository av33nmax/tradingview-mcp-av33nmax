import { cn } from "@/lib/utils";

/**
 * The Avalgo wordmark — green/red AV drawn as a stock chart pattern with
 * volume bars below, followed by "Algo" in a clean sans-serif. Confirmed
 * brand 2026-05-06 (replaces ABALGO golden-stencil wordmark from 2026-05-05).
 *
 * Colors:
 *   green up-stroke  #1D9E75
 *   red down-stroke  #E24B4A
 *   "Algo" text      currentColor (inherits from parent — works in both
 *                    light and dark themes)
 *
 * Renders inline so it can sit alongside other text in a heading, e.g.:
 *
 *   <h1>
 *     <AvalgoWordmark /> Cro$$hair 0DTE Options
 *   </h1>
 *
 * Source artwork: dashboard/public/avalgo-banner.svg (kept as fallback for
 * og:image, manifest icons, and contexts where inline SVG isn't available).
 */
export function AvalgoWordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline align-baseline", className)} aria-label="Avalgo">
      <svg
        viewBox="0 0 680 320"
        role="img"
        aria-hidden="true"
        style={{ height: "1.6em", width: "auto", display: "inline-block" }}
      >
        <title>Avalgo</title>
        {/* A: up-stroke (green) */}
        <path d="M 50 220 L 105 60" fill="none" stroke="#1D9E75" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
        {/* A: down-stroke (red) */}
        <path d="M 105 60 L 160 220" fill="none" stroke="#E24B4A" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
        {/* V: down-stroke (red) */}
        <path d="M 170 80 L 225 270" fill="none" stroke="#E24B4A" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
        {/* V: breakout up-stroke (green) */}
        <path d="M 225 270 L 280 20" fill="none" stroke="#1D9E75" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
        {/* "Algo" wordmark — currentColor so it works on dark + light backgrounds */}
        <text
          x="278"
          y="215"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
          fontSize="130"
          fontWeight="500"
          fill="currentColor"
          letterSpacing="-5"
        >
          Algo
        </text>
        {/* Volume bars — opacity 0.6 keeps them as a subtle decoration */}
        <g opacity="0.6">
          <rect x="48"  y="295" width="10" height="14" fill="#1D9E75" rx="1" />
          <rect x="64"  y="290" width="10" height="19" fill="#1D9E75" rx="1" />
          <rect x="80"  y="282" width="10" height="27" fill="#1D9E75" rx="1" />
          <rect x="96"  y="274" width="10" height="35" fill="#1D9E75" rx="1" />
          <rect x="112" y="284" width="10" height="25" fill="#E24B4A" rx="1" />
          <rect x="128" y="289" width="10" height="20" fill="#E24B4A" rx="1" />
          <rect x="144" y="294" width="10" height="15" fill="#E24B4A" rx="1" />
          <rect x="168" y="296" width="10" height="13" fill="#E24B4A" rx="1" />
          <rect x="184" y="293" width="10" height="16" fill="#E24B4A" rx="1" />
          <rect x="200" y="289" width="10" height="20" fill="#E24B4A" rx="1" />
          <rect x="216" y="283" width="10" height="26" fill="#1D9E75" rx="1" />
          <rect x="232" y="273" width="10" height="36" fill="#1D9E75" rx="1" />
          <rect x="248" y="263" width="10" height="46" fill="#1D9E75" rx="1" />
          <rect x="264" y="253" width="10" height="56" fill="#1D9E75" rx="1" />
        </g>
      </svg>
    </span>
  );
}
