import { cn } from "@/lib/utils";

/**
 * n8n thinking indicator: MCPJam's three-dot bounce wave, recolored to n8n's
 * coral brand red (`#FF6D5A`, the n8n logo fill). The real n8n MCP Client Tool
 * runs headless (no chat surface of its own), so there's no bespoke "thinking"
 * glyph to clone — the team's call is the house three-dot wave in n8n red.
 *
 * Reuses the `mcpjam-mark-dot-wave` keyframes via `.n8n-mark-indicator`
 * (defined in index.css), so it inherits the same timing and the
 * `prefers-reduced-motion` fallback. Registry-shaped: accepts only
 * `className` so it slots into any `HostChatUi.loadingIndicator`.
 */
export function N8nMarkIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-n8n"
        className="n8n-mark-indicator"
      >
        <span className="n8n-mark-indicator__dot n8n-mark-indicator__dot--1" />
        <span className="n8n-mark-indicator__dot n8n-mark-indicator__dot--2" />
        <span className="n8n-mark-indicator__dot n8n-mark-indicator__dot--3" />
      </span>
    </span>
  );
}
