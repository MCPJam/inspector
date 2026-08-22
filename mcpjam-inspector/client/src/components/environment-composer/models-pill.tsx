/**
 * Models slot of the environment composer — the second fan-out axis.
 *
 * Two modes on one component (TL):
 *  - `multiple` (evals): "Client defaults" checkbox first, then catalog
 *    models as checkboxes. Value is a {@link ModelSelection}.
 *  - `single`: picking a catalog model replaces the current explicit
 *    pick and closes — for future quick-switch surfaces.
 *
 * Cap awareness (D6): when `budget` is provided, an option that would
 * push the product over `maxTargets` is disabled with the product
 * explanation. A static `max=10` inside this pill is not sufficient.
 */
import { useMemo, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import {
  targetProductCapReason,
  type ModelSelection,
  type TargetBudgetContext,
} from "@/components/environment-composer/environment-stack";
import { useAvailableModels } from "@/hooks/use-available-models";
import { cn } from "@/lib/utils";

export function ModelsPill({
  projectId,
  value,
  onChange,
  mode = "multiple",
  disabled,
  testId,
  inModal = false,
  budget,
  clientDefaultLabel,
}: {
  projectId: string;
  value: ModelSelection;
  onChange: (next: ModelSelection) => void;
  mode?: "single" | "multiple";
  disabled?: boolean;
  testId?: string;
  inModal?: boolean;
  /** Product-cap context from the composer. Absent ⇒ no product disable. */
  budget?: TargetBudgetContext;
  /** Secondary text on the Client-defaults row (the previewed host's model). */
  clientDefaultLabel?: string | null;
}) {
  const { availableModels } = useAvailableModels({ projectId });
  const [open, setOpen] = useState(false);

  const explicit = value.explicitModelIds;
  const includeDefaults = value.includeClientDefaults;
  const triggerLabel = useMemo(
    () => modelsPillTriggerLabel(value),
    [value]
  );

  const toggleDefaults = (checked: boolean) => {
    if (mode === "single") {
      onChange({ includeClientDefaults: checked, explicitModelIds: [] });
      setOpen(false);
      return;
    }
    onChange({ ...value, includeClientDefaults: checked });
  };

  const toggleModel = (modelId: string, checked: boolean) => {
    if (mode === "single") {
      onChange({
        includeClientDefaults: false,
        explicitModelIds: checked ? [modelId] : [],
      });
      setOpen(false);
      return;
    }
    if (checked) {
      if (explicit.includes(modelId)) return;
      onChange({ ...value, explicitModelIds: [...explicit, modelId] });
      return;
    }
    onChange({
      ...value,
      explicitModelIds: explicit.filter((id) => id !== modelId),
    });
  };

  const defaultsCapBlocked =
    mode === "multiple" &&
    !includeDefaults &&
    wouldExceedBudget(budget, { extraChoices: 1 });
  const modelCapBlocked = (modelId: string, checked: boolean) =>
    mode === "multiple" &&
    !checked &&
    wouldExceedBudget(budget, { extraChoices: 1 });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next || !disabled) setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          aria-label="Models"
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
            "outline-none transition-colors",
            includeDefaults || explicit.length > 0
              ? "border-border/60 bg-muted/40 hover:bg-muted/60"
              : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-1"
        align="start"
        sideOffset={4}
        portalled={!inModal}
      >
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {mode === "single" ? "Model" : "Models · fan-out"}
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          <Label
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
              (defaultsCapBlocked || disabled) &&
                "cursor-not-allowed opacity-60 hover:bg-transparent"
            )}
          >
            <Checkbox
              checked={includeDefaults}
              onCheckedChange={(next) => toggleDefaults(next === true)}
              disabled={defaultsCapBlocked || disabled}
              aria-label="Client defaults"
              data-testid={testId ? `${testId}-client-defaults` : undefined}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-normal">Client defaults</span>
              {clientDefaultLabel ? (
                <span className="block truncate text-[10px] text-muted-foreground">
                  {clientDefaultLabel}
                </span>
              ) : null}
            </span>
          </Label>
          {defaultsCapBlocked && budget ? (
            <p className="px-2 pb-1 text-[10px] text-muted-foreground">
              {targetProductCapReason(
                budget.hostCount,
                budget.choiceCount + 1,
                budget.maxTargets
              )}
            </p>
          ) : null}
          {availableModels.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No catalog models available.
            </p>
          ) : (
            availableModels.map((model) => {
              const id = String(model.id);
              const checked = explicit.includes(id);
              const locked = model.disabled === true;
              const capBlocked = modelCapBlocked(id, checked);
              const optionDisabled = locked || capBlocked || disabled;
              return (
                <Label
                  key={id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30",
                    optionDisabled &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent"
                  )}
                  title={
                    locked
                      ? model.disabledReason
                      : capBlocked && budget
                        ? targetProductCapReason(
                            budget.hostCount,
                            budget.choiceCount + 1,
                            budget.maxTargets
                          )
                        : undefined
                  }
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => toggleModel(id, next === true)}
                    disabled={optionDisabled}
                    aria-label={compactModelLabel(model.name) || id}
                  />
                  <span className="min-w-0 flex-1 truncate font-normal">
                    {compactModelLabel(model.name) || id}
                  </span>
                </Label>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function modelsPillTriggerLabel(value: ModelSelection): string {
  const n = value.explicitModelIds.length;
  if (value.includeClientDefaults && n === 0) return "Client defaults";
  if (value.includeClientDefaults && n > 0) return `Client defaults +${n}`;
  if (n === 1) return "1 model";
  if (n > 1) return `${n} models`;
  return "No models · pick some";
}

function wouldExceedBudget(
  budget: TargetBudgetContext | undefined,
  delta: { extraChoices: number }
): boolean {
  if (!budget) return false;
  const nextChoices = budget.choiceCount + delta.extraChoices;
  return budget.hostCount * nextChoices > budget.maxTargets;
}
