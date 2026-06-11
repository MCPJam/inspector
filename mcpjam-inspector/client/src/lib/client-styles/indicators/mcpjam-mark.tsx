import { cn } from "@/lib/utils";

/**
 * MCPJam thinking indicator: three `primary` dots in a staggered bounce
 * wave (`mcpjam-mark-dot-wave` in index.css). Distinct from ChatGPT's
 * single grey dot and Claude's morphing brand mark.
 *
 * Honors `prefers-reduced-motion` via the CSS media query fallback.
 * Registry-shaped: accepts only `className` so it slots into any
 * `HostChatUi.loadingIndicator`.
 */
export function MCPJamMarkIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-mcpjam"
        className="mcpjam-mark-indicator"
      >
        <span className="mcpjam-mark-indicator__dot mcpjam-mark-indicator__dot--1 bg-primary" />
        <span className="mcpjam-mark-indicator__dot mcpjam-mark-indicator__dot--2 bg-primary" />
        <span className="mcpjam-mark-indicator__dot mcpjam-mark-indicator__dot--3 bg-primary" />
      </span>
    </span>
  );
}
