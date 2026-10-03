import { Plus } from "lucide-react";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { EffortControl } from "@/components/effort/effort-control";
import { reasoningEffortDefaultForRow } from "@/lib/reasoning-effort-options";
import type { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";

/** One compare card's effort: its chip and "Compare another effort". */
export type CompareCardEffortProps = {
  /** Levels the card's row supports; empty (and no saved level) hides the chip. */
  levels: readonly ModelReasoningEffort[];
  value: ModelReasoningEffort | undefined;
  onChange: (effort: ModelReasoningEffort | undefined) => void;
  /** Adds a card of the same model at another level; omitted ⇒ no action. */
  onCompareAnotherEffort?: () => void;
  disabled?: boolean;
};

export function CompareCardEffort({
  model,
  levels,
  value,
  onChange,
  onCompareAnotherEffort,
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
      {onCompareAnotherEffort ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onCompareAnotherEffort}
          data-testid="compare-another-effort"
          aria-label={`Compare another effort of ${model.name}`}
          title="Compare another effort"
          className="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Compare another effort</span>
        </Button>
      ) : null}
    </div>
  );
}
