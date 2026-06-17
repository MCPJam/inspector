import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

/**
 * VS Code (GitHub Copilot Chat) thinking indicator — the shimmer that
 * sweeps the progress-step text Copilot shows while the agent is working
 * ("Optimizing tool selection", "Planning…", "Generating…", …). Like
 * Cursor, the shimmer (not the wording) is the brand's busy-state
 * identity; Copilot rotates the verb but the same `chat-thinking-shimmer`
 * keyframe rides all of them. We render one stable representative verb.
 *
 * Captured verbatim from VS Code's Copilot Chat DevTools (the animated
 * `p.chat-thinking-shimmer` node):
 *
 *   color: rgb(140, 140, 140);                       // #8C8C8C base
 *   background-image: linear-gradient(
 *     90deg,
 *     #8C8C8C 0%, #8C8C8C 30%,
 *     #FFFFFF 50%,                                    // pure-white highlight
 *     #8C8C8C 70%, #8C8C8C 100%
 *   );
 *   background-size: 400% 100%;                       // wider than Cursor's 200%
 *   background-clip: text; -webkit-text-fill-color: transparent;
 *   animation: chat-thinking-shimmer 2s linear infinite;
 *   @keyframes chat-thinking-shimmer {
 *     0%   { background-position: 120% 0; }
 *     100% { background-position: -120% 0; }
 *   }
 *
 * Distinct from {@link CursorShineIndicator}: VS Code's highlight is pure
 * white (vs Cursor's dimmer `--text-primary`), the gradient is 400% wide
 * with a tighter bright band, and the sweep travels 120% → -120% (Cursor
 * runs 100% → -100% over a 200% field). That's the difference the team
 * flagged — VS Code reads brighter and the stripe is narrower. The rule
 * lives under `.vscode-shimmer-indicator` in `index.css` (keyframe
 * `vscode-shimmer`); `--vscode-shimmer-{base,highlight}` toggle dark vs
 * light via `data-theme` (dark is the verbatim #8C8C8C/#FFF capture).
 *
 * Honors `prefers-reduced-motion` via a `@media` rule in `index.css`.
 *
 * Registry-shaped: accepts only `className`.
 */
export function VSCodeShimmerIndicator({ className }: { className?: string }) {
  // Chat-shell host theme. Falls back to "dark" to match the rest of the
  // inspector's "no chatbox context" behavior (see CopilotMessageHeader).
  const chatboxHostTheme = useChatboxHostTheme() ?? "dark";

  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        data-testid="loading-indicator-vscode-shimmer"
        data-theme={chatboxHostTheme}
        className="vscode-shimmer-indicator text-sm"
      >
        Working
      </span>
      <span className="sr-only">Working</span>
    </span>
  );
}
