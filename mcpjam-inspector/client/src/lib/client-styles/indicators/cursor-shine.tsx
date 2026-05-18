import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

/**
 * Cursor's thinking indicator — the "shine" effect applied to the
 * "Planning next moves" status text Cursor's agent panel shows while
 * the model is reasoning. The shimmer (not the wording) is the brand's
 * identity for the busy state; Cursor swaps the verb based on phase
 * ("Planning next moves", "Editing files", "Reading files", …) but the
 * same `.make-shine` keyframe rides them all.
 *
 * Captured verbatim from Cursor 1.x DevTools computed styles:
 *
 *   background-image: linear-gradient(
 *     90deg,
 *     var(--text-tertiary) 0,
 *     var(--text-tertiary) 40%,
 *     var(--text-primary)  50%,
 *     var(--text-tertiary) 60%,
 *     var(--text-tertiary) 100%
 *   );
 *   background-size: 200% 100%;
 *   background-clip: text;
 *   -webkit-text-fill-color: transparent;
 *   animation: shine 2s linear infinite;
 *   will-change: background-position;
 *
 * `--text-tertiary` and `--text-primary` both derive from Cursor's
 * `--base` foreground tone (48% and 94% opacity over the surface). We
 * mirror that with a single `--cursor-shine-base` custom property set
 * in `index.css`, and toggle dark vs light via `data-theme` on the
 * shimmer span. The keyframe is namespaced `cursor-shine` (not
 * `shine`) to avoid colliding with the unrelated `.make-shine` glow
 * used elsewhere in the codebase.
 *
 * Honors `prefers-reduced-motion` via a `@media` rule in `index.css`
 * (kills the animation and falls back to `currentColor`).
 *
 * Registry-shaped: accepts only `className`.
 */
export function CursorShineIndicator({ className }: { className?: string }) {
  // Chat-shell host theme. Falls back to "dark" to match the rest of
  // the inspector's "no chatbox context" behavior (see CopilotMessageHeader).
  const chatboxHostTheme = useChatboxHostTheme() ?? "dark";

  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        data-testid="loading-indicator-cursor-shine"
        data-theme={chatboxHostTheme}
        className="cursor-shine-indicator text-sm"
      >
        Planning next moves
      </span>
      <span className="sr-only">Planning next moves</span>
    </span>
  );
}
