/**
 * Shared color chip for MCP Apps style-token surfaces (the caniuse compare
 * matrix and the Apps tab's token block).
 *
 * Lives here rather than beside either consumer because both draw the same
 * thing: two hex strings are only comparable once you can see them, and a
 * fully transparent `…-ghost` token has to be distinguishable from an opaque
 * white one — which is what the checkerboard is for. Kept in one file so a
 * tweak to the checker size or contrast can't drift the two surfaces apart.
 */

import { cn } from "@/lib/utils";

/**
 * Alpha-revealing checkerboard, hoisted so it isn't rebuilt per cell — the
 * compare matrix renders one per color per host, across ~76 style rows.
 */
export const STYLE_SWATCH_CHECKERBOARD = {
  backgroundImage:
    "linear-gradient(45deg, rgba(120,120,120,0.35) 25%, transparent 25%, transparent 75%, rgba(120,120,120,0.35) 75%), linear-gradient(45deg, rgba(120,120,120,0.35) 25%, transparent 25%, transparent 75%, rgba(120,120,120,0.35) 75%)",
  backgroundSize: "6px 6px",
  backgroundPosition: "0 0, 3px 3px",
} as const;

/**
 * One token's color. The value is assigned as a real CSS property (never
 * spliced into a CSS string), so a token this build doesn't understand — a
 * `color-mix(…)` an older engine rejects, or a malformed value from a
 * user-built host — is dropped by the CSSOM and leaves an empty chip rather
 * than corrupting the surrounding declaration.
 */
export function StyleColorSwatch({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3 shrink-0 overflow-hidden rounded-[3px] border border-border/70 align-middle",
        className
      )}
      style={STYLE_SWATCH_CHECKERBOARD}
    >
      <span className="block size-full" style={{ backgroundColor: value }} />
    </span>
  );
}
