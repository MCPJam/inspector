import { cn } from "@/lib/utils";
import type { IndicatorDef } from "../types";

/**
 * Data-driven loading indicator renderer for custom host styles. Built-in
 * hosts (Claude, ChatGPT, Cursor, MCPJam) keep their bespoke React
 * components — those are referenced directly by `HostStyleDefinition`. A
 * user-defined host stores its indicator as data (`IndicatorDef`); the
 * resolver in `registry.ts` wraps that data in this dispatcher so the
 * `loadingIndicator: ComponentType` contract still holds at the render
 * boundary.
 *
 * Variants:
 * - `{ kind: "dots" }` — 1–3 small dots in `color` (default MCPJam orange),
 *   staggered via the existing `animate-thinking-dot-pulse` keyframe in
 *   `src/index.css:344`. Honors `prefers-reduced-motion` because the
 *   Tailwind `animate-*` utility does.
 * - `{ kind: "image" }` — user-supplied URL; `animation` chooses between
 *   continuous spin (`spin`), gentle pulse (`pulse`), or none. Reuses the
 *   Tailwind `animate-spin` and `animate-pulse` utilities; both already
 *   respect `prefers-reduced-motion`.
 */

const DEFAULT_DOTS_COLOR = "#F2735B"; // MCPJam orange (matches mcp_jam.svg).

const STAGGER_DELAYS_MS: Record<1 | 2 | 3, number[]> = {
  1: [0],
  2: [0, 150],
  3: [0, 150, 300],
};

export function HostIndicatorDispatch({
  def,
  className,
}: {
  def: IndicatorDef;
  className?: string;
}) {
  if (def.kind === "dots") {
    const color = def.color ?? DEFAULT_DOTS_COLOR;
    const count = def.count ?? 3;
    const delays = STAGGER_DELAYS_MS[count];
    return (
      <span
        className={cn("inline-flex min-h-6 items-center gap-1", className)}
        aria-live="polite"
      >
        <span className="sr-only">Thinking</span>
        <span
          aria-hidden="true"
          data-testid="loading-indicator-dispatch-dots"
          data-dot-count={count}
          className="inline-flex items-center gap-1"
        >
          {delays.map((delayMs, i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 rounded-full animate-thinking-dot-pulse"
              style={{ backgroundColor: color, animationDelay: `${delayMs}ms` }}
            />
          ))}
        </span>
      </span>
    );
  }

  // `kind: "image"`
  const animationClass =
    def.animation === "spin"
      ? "animate-spin"
      : def.animation === "none"
        ? ""
        : "animate-pulse";
  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span className="sr-only">Thinking</span>
      <img
        src={def.src}
        alt=""
        aria-hidden="true"
        data-testid="loading-indicator-dispatch-image"
        data-animation={def.animation ?? "pulse"}
        className={cn("h-5 w-5 object-contain", animationClass)}
      />
    </span>
  );
}
