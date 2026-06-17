import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

/**
 * AWS Bedrock AgentCore thinking indicator — the same shimmer effect
 * Cursor/Codex use on their status text (see `cursor-shine.tsx` for the
 * verbatim Cursor 1.x DevTools capture). AgentCore is a server-side
 * agent runtime with no chat UI of its own (text servers only — see the
 * AgentCore entry in `built-ins.ts`), so there's no real surface to
 * clone. We deliberately reuse the generic "subtle sweep over status
 * text" shimmer rather than inventing AWS-branded chrome — the honest,
 * design-free busy state for a host that renders nothing.
 *
 * Visual rules live alongside `.cursor-shine-indicator` in `index.css`
 * via a multi-selector rule — the gradient, the `--cursor-shine-base`
 * tone, the light-mode override, and the reduced-motion fallback all
 * apply to `.agentcore-shine-indicator` too. The keyframe name
 * (`cursor-shine`) and custom-property name stay Cursor-flavored; they're
 * stylesheet-internal.
 *
 * Honors `prefers-reduced-motion` via the same `@media` rule in
 * `index.css` (kills the animation and falls back to `currentColor`).
 *
 * Registry-shaped: accepts only `className`.
 */
export function AgentCoreShineIndicator({ className }: { className?: string }) {
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
        data-testid="loading-indicator-agentcore-shine"
        data-theme={chatboxHostTheme}
        className="agentcore-shine-indicator text-sm"
      >
        Thinking
      </span>
      <span className="sr-only">Thinking</span>
    </span>
  );
}
