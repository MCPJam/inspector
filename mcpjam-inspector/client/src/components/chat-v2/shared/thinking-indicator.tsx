import { ModelDefinition } from "@/shared/types";
import {
  LoadingIndicatorContent,
  type LoadingIndicatorVariant,
} from "./loading-indicator-content";

export function ThinkingIndicator({
  model,
  variant = "default",
}: {
  model: ModelDefinition;
  variant?: LoadingIndicatorVariant;
}) {
  return (
    <article
      className="w-full text-sm leading-6 text-muted-foreground"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="inline-flex items-center gap-2 text-muted-foreground/80">
        <LoadingIndicatorContent variant={variant} />
      </div>
    </article>
  );
}
