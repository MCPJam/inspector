import { cn } from "@/lib/utils";
import { ClaudeLoadingIndicator } from "./claude-loading-indicator";

export type LoadingIndicatorVariant = "default" | "chatgpt-dot" | "claude-mark";

interface LoadingIndicatorContentProps {
  variant?: LoadingIndicatorVariant;
  className?: string;
}

export function LoadingIndicatorContent({
  variant = "default",
  className,
}: LoadingIndicatorContentProps) {
  if (variant === "claude-mark") {
    return <ClaudeLoadingIndicator className={className} />;
  }

  if (variant === "chatgpt-dot") {
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
