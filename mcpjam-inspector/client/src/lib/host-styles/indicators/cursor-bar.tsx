import { cn } from "@/lib/utils";

/**
 * Cursor-style thinking indicator: a vertical bar that blinks on/off,
 * echoing the I-beam text caret the brand is named after. Uses a step-end
 * blink so the toggle is sharp (terminal cursor cadence) rather than a
 * smooth fade.
 *
 * Honors `prefers-reduced-motion` via Tailwind's animate utilities (the
 * keyframe is suppressed under reduced motion at the OS level).
 *
 * Registry-shaped: accepts only `className` so it drops into any
 * `HostChatUi.loadingIndicator` slot.
 */
export function CursorBarIndicator({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex min-h-6 items-center", className)}>
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-cursor-bar"
        className="inline-block h-4 w-[2px] bg-foreground animate-[blink_1s_step-end_infinite]"
      />
    </span>
  );
}
