import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import { EffortControl } from "@/components/effort/effort-control";
import { reasoningEffortDefaultForRow } from "@/lib/reasoning-effort-options";
import type { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";

/**
 * One compare card's effort chip. Adding the same model at another effort
 * happens in the model menu (each model opens its efforts to the side).
 */
export type CompareCardEffortProps = {
  /** Levels the card's row supports; empty (and no saved level) hides the chip. */
  levels: readonly ModelReasoningEffort[];
  value: ModelReasoningEffort | undefined;
  onChange: (effort: ModelReasoningEffort | undefined) => void;
  disabled?: boolean;
};

export function CompareCardEffort({
  model,
  levels,
  value,
  onChange,
  disabled = false,
  className,
}: CompareCardEffortProps & { model: ModelDefinition; className?: string }) {
  if (levels.length === 0 && value === undefined) return null;
  return (
    <div
      data-testid="compare-card-effort"
      className={cn("flex shrink-0 items-center gap-0.5", className)}
    >
      <EffortControl
        variant="inline"
        options={levels}
        value={value}
        defaultLevel={reasoningEffortDefaultForRow(model)}
        onChange={onChange}
        disabled={disabled}
        disabledReason="Reasoning effort can't change while a reply is streaming"
      />
    </div>
  );
}
