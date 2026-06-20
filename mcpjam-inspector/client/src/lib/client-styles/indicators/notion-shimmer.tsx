import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

/**
 * Notion AI's "thinking" indicator — the shimmer-text effect Notion's agent
 * rides on its busy-state status label ("Working", "Brewing", …). The sweep
 * (not the wording) is the brand's identity for the busy state; Notion swaps
 * the verb per phase but the same `.nds-shimmer-text` keyframe rides them all.
 *
 * Captured verbatim from Notion's DevTools computed styles (light theme):
 *
 *   background-image: linear-gradient(
 *     to right,
 *     var(--shimmer-text-faded-color) 0%,   // --c-texDis  → #d4d3cf
 *     var(--c-texSec)                 50%,   // secondary   → #7d7a75
 *     var(--shimmer-text-faded-color) 100%
 *   );
 *   background-size: 200% 100%;
 *   background-clip: text;
 *   animation: nds-shimmer-text 1.5s linear infinite;
 *
 * The element class on Notion's side is literally `nds-shimmer-text`; we reuse
 * that name for the CSS rule + keyframes in `index.css`. Light-theme tones are
 * the verbatim capture; dark-theme tones are reconstructed (the probe was
 * light theme) and swapped via `data-theme`. The `@keyframes` endpoints are
 * also reconstructed to reproduce the sweep — only the animation name, 200%
 * background size, 1.5s linear timing, and the resting `200% 50%` position
 * came across the wire.
 *
 * Honors `prefers-reduced-motion` via a `@media` rule in `index.css`.
 *
 * Registry-shaped: accepts only `className`.
 */
export function NotionShimmerIndicator({ className }: { className?: string }) {
  // Chat-shell host theme. Falls back to "dark" to match the rest of the
  // inspector's "no chatbox context" behavior (see other shimmer indicators).
  const chatboxHostTheme = useChatboxHostTheme() ?? "dark";

  return (
    <span
      className={cn("inline-flex min-h-6 items-center gap-1.5", className)}
      aria-live="polite"
    >
      {/* 47-frame sprite of Notion's <canvas> loader, played at the canvas's
          measured ~1.567s loop. Captured from notion.so. */}
      <span
        aria-hidden="true"
        data-theme={chatboxHostTheme}
        className="notion-loader-icon"
      />
      <span
        aria-hidden="true"
        data-testid="loading-indicator-notion-shimmer"
        data-theme={chatboxHostTheme}
        className="nds-shimmer-text text-sm"
      >
        Working
      </span>
      <span className="sr-only">Working</span>
    </span>
  );
}
