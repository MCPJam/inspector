import { cn } from "@/lib/utils";

/**
 * ChatGPT-style thinking indicator: a single pulsing dot. Honors
 * `prefers-reduced-motion` via the `animate-thinking-dot-pulse` Tailwind
 * keyframe, which the `animate-*` utilities respect by design.
 *
 * Registry-shaped: accepts only `className` so it can drop into any
 * `HostChatUi.loadingIndicator` slot.
 */
export function ChatGptDotIndicator({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex min-h-6 items-center", className)}>
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-dot"
        className="inline-block h-3 w-3 rounded-full bg-foreground animate-thinking-dot-pulse"
      />
    </span>
  );
}
