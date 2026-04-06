import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

const HINT_LABEL = "Try this prompt with a demo MCP server";

interface HandDrawnSendHintProps {
  hostStyle?: string;
  theme?: "light" | "dark";
}

/**
 * Whimsical hand-drawn arrow + handwriting annotation that nudges
 * first-time users toward the Send button. Replaces the old orange
 * modal + bouncing ArrowUp icon.
 *
 * The SVG arrow draws itself on via stroke-dashoffset animation,
 * then the text fades in with a slight upward slide.
 */
export function HandDrawnSendHint({
  hostStyle,
  theme = "light",
}: HandDrawnSendHintProps) {
  const prefersReducedMotion = useReducedMotion();

  const inkColor =
    hostStyle === "chatgpt"
      ? theme === "dark"
        ? "text-neutral-400"
        : "text-neutral-500"
      : theme === "dark"
        ? "text-[#c4a882]"
        : "text-[#6b5e50]";

  const textColor =
    hostStyle === "chatgpt"
      ? theme === "dark"
        ? "text-neutral-300"
        : "text-neutral-600"
      : theme === "dark"
        ? "text-[#d4c4a8]"
        : "text-[#5a4f42]";

  return (
    <div
      className="relative mt-1 flex w-full justify-end px-4"
      role="note"
      aria-live="polite"
      data-testid="app-builder-send-nux-hint"
    >
      <div className="flex flex-col items-end gap-0">
        {/* Hand-drawn arrow SVG — curves upward toward the Send button */}
        <svg
          width="120"
          height="72"
          viewBox="0 0 120 72"
          fill="none"
          className={cn("mr-3 -mb-1", inkColor)}
          aria-hidden
        >
          {/* Wobbly arrow body with a playful loop in the middle */}
          <path
            d="M10 66 C 18 56, 26 44, 36 38 C 42 34, 48 28, 46 34 C 44 40, 36 40, 38 34 C 40 28, 52 20, 64 16 C 78 10, 90 8, 102 6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
            className={cn(
              !prefersReducedMotion && "hand-draw-path hand-draw-path-body",
            )}
            pathLength="1"
          />
          {/* Arrowhead — two short hand-drawn strokes */}
          <path
            d="M95 1 Q 99 3, 102 6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
            className={cn(
              !prefersReducedMotion && "hand-draw-path hand-draw-path-head",
            )}
            pathLength="1"
          />
          <path
            d="M96 13 Q 99 10, 102 6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
            className={cn(
              !prefersReducedMotion && "hand-draw-path hand-draw-path-head",
            )}
            pathLength="1"
          />
        </svg>

        {/* Handwriting label */}
        <p
          className={cn(
            "mr-6 max-w-[14rem] text-right text-[15px] leading-snug select-none",
            textColor,
            !prefersReducedMotion && "hand-draw-text-appear",
          )}
          style={{ fontFamily: "'Caveat', cursive", fontWeight: 600 }}
        >
          {HINT_LABEL}
        </p>
      </div>
    </div>
  );
}
