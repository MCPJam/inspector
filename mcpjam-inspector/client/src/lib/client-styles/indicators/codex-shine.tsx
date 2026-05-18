import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

/**
 * Codex's thinking indicator — the same shimmer effect Cursor uses on its
 * "Planning next moves" status text (see `cursor-shine.tsx` for the
 * verbatim Cursor 1.x DevTools capture). Real Codex is a CLI tool that
 * doesn't render chat UI, so this indicator is a stand-in for the
 * playground's Codex skin rather than a faithful clone of any real Codex
 * surface. We reuse Cursor's shimmer because the IDE/terminal "subtle
 * sweep over status text" idiom maps well onto an OpenAI CLI mood, and
 * the CSS keyframe is already in place.
 *
 * Visual rules live alongside `.cursor-shine-indicator` in `index.css`
 * via a multi-selector rule — the gradient, the `--cursor-shine-base`
 * tone, the light-mode override, and the reduced-motion fallback all
 * apply to `.codex-shine-indicator` too. We keep the existing keyframe
 * name (`cursor-shine`) and custom-property name to avoid churning
 * Cursor's tests/CSS; consider them stylesheet-internal.
 *
 * Honors `prefers-reduced-motion` via the same `@media` rule in
 * `index.css` (kills the animation and falls back to `currentColor`).
 *
 * Registry-shaped: accepts only `className`.
 */
export function CodexShineIndicator({ className }: { className?: string }) {
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
        data-testid="loading-indicator-codex-shine"
        data-theme={chatboxHostTheme}
        className="codex-shine-indicator text-sm"
      >
        Thinking
      </span>
      <span className="sr-only">Thinking</span>
    </span>
  );
}
