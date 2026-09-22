import {
  useScenarioChatUiOverride,
  useScenarioHostStyle,
} from "@/contexts/scenario-client-style-context";
import {
  getScenarioHostFamily,
  type ScenarioHostStyle,
} from "@/lib/scenario-client-style";
import { getLoadingIndicatorForStyle } from "@/lib/client-styles";
import { cn } from "@/lib/utils";

function modelProviderToHostStyle(
  provider: string | null | undefined
): ScenarioHostStyle | null {
  if (!provider) return null;
  const normalized = provider.toLowerCase();
  if (normalized === "openai") return "chatgpt";
  if (normalized === "anthropic") return "claude";
  return null;
}

/**
 * Resolve the host style id used to pick the brand thinking indicator.
 * Prefers the active scenario host context, falling back to a
 * `modelProvider → host id` mapping for surfaces with no scenario context
 * (e.g. Direct Chat without a saved profile).
 *
 * Returns `null` only when neither source resolves; callers should render
 * a generic fallback in that case.
 */
export function useResolvedHostStyleForIndicator(
  modelProvider?: string | null
): ScenarioHostStyle | null {
  const scenarioHostStyle = useScenarioHostStyle();
  return scenarioHostStyle ?? modelProviderToHostStyle(modelProvider);
}

/** Claude paints its mark beneath the last assistant bubble while streaming. */
export function usesClaudeInlineStreamingFooter(
  hostStyle: ScenarioHostStyle | null
): boolean {
  return (
    hostStyle != null &&
    hostStyle !== "mcpjam" &&
    // Claude Code borrows the "claude" visual family for bubble styling but
    // is a terminal agent — it shows its own CLI spinner indicator (via the
    // generic LoadingIndicatorContent path), not the claude.ai mark painted
    // beneath the assistant bubble. Same opt-out shape as "mcpjam".
    hostStyle !== "claude-code" &&
    // AgentCore likewise borrows the "claude" family for warm bubble chrome
    // but is a text-only AWS runtime, not claude.ai — it shows a generic
    // shimmer indicator, so it must NOT paint the Anthropic mark beneath the
    // bubble while streaming. Same opt-out shape as "claude-code".
    hostStyle !== "agentcore" &&
    getScenarioHostFamily(hostStyle) === "claude"
  );
}

/** MCPJam uses its own dot indicator in the same footer slot. */
export function usesMcpjamInlineStreamingFooter(
  hostStyle: ScenarioHostStyle | null
): boolean {
  return hostStyle === "mcpjam";
}

/**
 * Brand thinking indicator. Looks up the host's `chatUi.loadingIndicator`
 * via the registry; falls back to an animated "Thinking…" string when
 * neither scenario context nor `modelProvider` resolves to a known host.
 */
export function LoadingIndicatorContent({
  className,
  modelProvider,
}: {
  className?: string;
  /** Optional provider hint for surfaces without a scenario host context. */
  modelProvider?: string | null;
}) {
  const hostStyle = useResolvedHostStyleForIndicator(modelProvider);
  const chatUiOverride = useScenarioChatUiOverride();

  if (hostStyle) {
    const Indicator = getLoadingIndicatorForStyle(hostStyle, chatUiOverride);
    return <Indicator className={className} />;
  }

  return (
    <span className={cn("text-sm italic", className)}>
      Thinking
      <span aria-hidden="true" className="inline-flex">
        <span className="animate-[blink_1.4s_ease-in-out_infinite]">.</span>
        <span className="animate-[blink_1.4s_ease-in-out_0.2s_infinite]">
          .
        </span>
        <span className="animate-[blink_1.4s_ease-in-out_0.4s_infinite]">
          .
        </span>
      </span>
    </span>
  );
}
