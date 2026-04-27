import { useChatboxHostStyle } from "@/contexts/chatbox-host-style-context";
import {
  getChatboxHostFamily,
  type ChatboxHostStyle,
} from "@/lib/chatbox-host-style";
import { cn } from "@/lib/utils";
import { ClaudeLoadingIndicator } from "./claude-loading-indicator";

export type LoadingIndicatorVariant = "default" | "chatgpt-dot" | "claude-mark";

export function getLoadingIndicatorVariantForHostStyle(
  hostStyle: ChatboxHostStyle | null | undefined,
): LoadingIndicatorVariant {
  const hostFamily = getChatboxHostFamily(hostStyle);
  if (hostFamily === "chatgpt") {
    return "chatgpt-dot";
  }

  if (hostFamily === "claude") {
    return "claude-mark";
  }

  return "default";
}

export function resolveLoadingIndicatorVariant({
  variant,
  hostStyle,
  modelProvider,
}: {
  variant?: LoadingIndicatorVariant;
  hostStyle?: ChatboxHostStyle | null;
  modelProvider?: string | null;
}): LoadingIndicatorVariant {
  if (variant !== undefined && variant !== "default") {
    return variant;
  }

  const hostVariant = getLoadingIndicatorVariantForHostStyle(hostStyle);
  if (hostVariant !== "default") {
    return hostVariant;
  }

  const normalizedProvider = modelProvider?.toLowerCase();
  if (normalizedProvider === "openai") {
    return "chatgpt-dot";
  }

  if (normalizedProvider === "anthropic") {
    return "claude-mark";
  }

  return "default";
}

export function useResolvedLoadingIndicatorVariant(
  variant?: LoadingIndicatorVariant,
  options?: { modelProvider?: string | null },
): LoadingIndicatorVariant {
  const chatboxHostStyle = useChatboxHostStyle();

  return resolveLoadingIndicatorVariant({
    variant,
    hostStyle: chatboxHostStyle,
    modelProvider: options?.modelProvider,
  });
}

export function LoadingIndicatorContent({
  variant,
  className,
}: {
  variant?: LoadingIndicatorVariant;
  className?: string;
}) {
  const resolvedVariant = useResolvedLoadingIndicatorVariant(variant);

  if (resolvedVariant === "claude-mark") {
    return <ClaudeLoadingIndicator className={className} />;
  }

  if (resolvedVariant === "chatgpt-dot") {
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
