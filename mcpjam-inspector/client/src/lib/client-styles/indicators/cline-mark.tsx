import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Cline thinking indicator — the Cline robot mark followed by a muted
 * "Thinking" label. The mark is a faithful reconstruction of Cline's logo
 * (rounded head, top nub, two pill eyes) drawn as a single silhouette with the
 * eyes punched out via a mask; it inherits `currentColor` so it tracks the
 * muted-foreground text color in both themes.
 *
 * The Cline 3.89.2 probe only carried the brand mark and MCP `initialize`
 * handshake — no captured busy-state animation — so the gentle pulse on the
 * mark is a neutral placeholder loading affordance, not Cline's real thinking
 * effect. The `.cline-mark-indicator` rule (and its reduced-motion guard) lives
 * in `index.css`.
 *
 * Registry-shaped: accepts only `className`.
 */
export function ClineMarkIndicator({ className }: { className?: string }) {
  const reactId = useId();
  const maskId = `cline-indicator-eyes-${reactId.replace(/:/g, "")}`;

  return (
    <span
      className={cn("inline-flex min-h-6 items-center gap-2", className)}
      aria-live="polite"
      data-testid="loading-indicator-cline"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 200 200"
        className="cline-mark-indicator block size-4 shrink-0"
        data-testid="loading-indicator-cline-mark"
      >
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="200"
          height="200"
        >
          <rect width="200" height="200" fill="#fff" />
          <rect x="64" y="92" width="28" height="72" rx="14" fill="#000" />
          <rect x="108" y="92" width="28" height="72" rx="14" fill="#000" />
        </mask>
        <g fill="currentColor" mask={`url(#${maskId})`}>
          <circle cx="100" cy="25" r="22" />
          <path d="M 52 46 L 148 46 A 37 37 0 0 1 185 83 Q 206 120 185 157 A 37 37 0 0 1 148 194 L 52 194 A 37 37 0 0 1 15 157 Q -6 120 15 83 A 37 37 0 0 1 52 46 Z" />
        </g>
      </svg>

      <span
        aria-hidden="true"
        data-testid="loading-indicator-cline-label"
        className="text-sm leading-5 font-medium text-muted-foreground/80"
      >
        Thinking
      </span>
      <span className="sr-only">Thinking</span>
    </span>
  );
}
