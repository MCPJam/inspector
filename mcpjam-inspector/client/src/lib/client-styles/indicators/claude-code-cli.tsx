import { cn } from "@/lib/utils";

/**
 * Claude Code thinking indicator — a braille spinner in a monospace face,
 * the universal CLI "working" affordance (the ⠋⠙⠹… cycle ora and most
 * terminal tools use). Claude Code borrows the Claude chat surface but is
 * a terminal agent, so its busy state is a CLI spinner rather than the
 * claude.ai mascot (`claude-mark.tsx`).
 *
 * The frames live in `@keyframes claude-code-cli-spinner` (`src/index.css`),
 * cycling `::before` content. Rendered in MCPJam orange via `text-primary`
 * (the `--primary` brand token — same source the MCPJam mark indicator uses
 * via `bg-primary`), so the spinner and label stay on-brand across themes.
 * Honors `prefers-reduced-motion` via an `@media` rule there (freezes on a
 * single static glyph). Visible glyphs are aria-hidden; an sr-only
 * "Thinking" carries the state for assistive tech.
 *
 * Registry-shaped: accepts only `className`.
 */
export function ClaudeCodeCliIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-claude-code-cli"
        className="claude-code-cli-indicator font-mono text-sm text-primary"
      >
        <span className="claude-code-cli-indicator__spinner" />
        <span className="claude-code-cli-indicator__label">Thinking</span>
      </span>
    </span>
  );
}
