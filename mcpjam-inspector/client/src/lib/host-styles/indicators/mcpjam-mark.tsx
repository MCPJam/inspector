import { cn } from "@/lib/utils";

/**
 * MCPJam thinking indicator: three small dots in the MCPJam orange,
 * staggered by the shared `animate-thinking-dot-pulse` keyframe (already
 * defined in index.css). Distinct from ChatGPT's single grey dot and
 * Claude's morphing brand mark — reads as "the inspector is thinking."
 *
 * Honors `prefers-reduced-motion` via the Tailwind `animate-*` utilities.
 * Registry-shaped: accepts only `className` so it slots into any
 * `HostChatUi.loadingIndicator`.
 */
export function MCPJamMarkIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex min-h-6 items-center gap-1", className)}
      aria-live="polite"
    >
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-mcpjam"
        className="inline-flex items-center gap-1"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full animate-thinking-dot-pulse"
          style={{ backgroundColor: "#F2735B", animationDelay: "0ms" }}
        />
        <span
          className="inline-block h-1.5 w-1.5 rounded-full animate-thinking-dot-pulse"
          style={{ backgroundColor: "#F2735B", animationDelay: "150ms" }}
        />
        <span
          className="inline-block h-1.5 w-1.5 rounded-full animate-thinking-dot-pulse"
          style={{ backgroundColor: "#F2735B", animationDelay: "300ms" }}
        />
      </span>
    </span>
  );
}
