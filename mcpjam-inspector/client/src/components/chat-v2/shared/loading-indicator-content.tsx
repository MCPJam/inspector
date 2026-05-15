import { useChatboxHostStyle } from "@/contexts/chatbox-host-style-context";
import { type ChatboxHostStyle } from "@/lib/chatbox-host-style";
import { getLoadingIndicatorForStyle } from "@/lib/host-styles";
import { cn } from "@/lib/utils";

function modelProviderToHostStyle(
  provider: string | null | undefined,
): ChatboxHostStyle | null {
  if (!provider) return null;
  const normalized = provider.toLowerCase();
  if (normalized === "openai") return "chatgpt";
  if (normalized === "anthropic") return "claude";
  return null;
}

/**
 * Resolve the host style id used to pick the brand thinking indicator.
 * Prefers the active chatbox host context, falling back to a
 * `modelProvider → host id` mapping for surfaces with no chatbox context
 * (e.g. Direct Chat without a saved profile).
 *
 * Returns `null` only when neither source resolves; callers should render
 * a generic fallback in that case.
 */
export function useResolvedHostStyleForIndicator(
  modelProvider?: string | null,
): ChatboxHostStyle | null {
  const chatboxHostStyle = useChatboxHostStyle();
  return chatboxHostStyle ?? modelProviderToHostStyle(modelProvider);
}

/**
 * Brand thinking indicator. Looks up the host's `chatUi.loadingIndicator`
 * via the registry; falls back to an animated "Thinking…" string when
 * neither chatbox context nor `modelProvider` resolves to a known host.
 */
export function LoadingIndicatorContent({
  className,
  modelProvider,
}: {
  className?: string;
  /** Optional provider hint for surfaces without a chatbox host context. */
  modelProvider?: string | null;
}) {
  const hostStyle = useResolvedHostStyleForIndicator(modelProvider);

  if (hostStyle) {
    const Indicator = getLoadingIndicatorForStyle(hostStyle);
    return <Indicator className={className} />;
  }

  return (
    <span className={cn("text-sm italic", className)}>
      Thinking
      <span aria-hidden="true" className="inline-flex">
        <span className="animate-[blink_1.4s_ease-in-out_infinite]">.</span>
        <span className="animate-[blink_1.4s_ease-in-out_0.2s_infinite]">.</span>
        <span className="animate-[blink_1.4s_ease-in-out_0.4s_infinite]">.</span>
      </span>
    </span>
  );
}
