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
  const catalogIds = useMemo(
    () => new Set(availableModels.map((model) => String(model.id))),
    [availableModels]
  );
  const staleExplicit = explicit.filter((id) => !catalogIds.has(id));
  const includeDefaults = value.includeClientDefaults;
  const catalogNameById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const model of availableModels) {
      const id = String(model.id);
      byId.set(id, compactModelLabel(model.name) || id);
    }
    return byId;
  }, [availableModels]);
  const triggerLabel = useMemo(
    () =>
      modelsPillTriggerLabel(value, {
        clientDefaultLabel,
        modelName: (id) => catalogNameById.get(id) || compactModelLabel(id) || id,
      }),
    [value, clientDefaultLabel, catalogNameById]
  );

  const replaceSoleChoice = canReplaceSoleChoice(budget);

  const toggleDefaults = (checked: boolean) => {
    if (mode === "single") {
      onChange({ includeClientDefaults: checked, explicitModelIds: [] });
      setOpen(false);
      return;
    }
    if (checked && replaceSoleChoice) {
      onChange({ includeClientDefaults: true, explicitModelIds: [] });
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
      if (replaceSoleChoice) {
        onChange({
          includeClientDefaults: false,
          explicitModelIds: [modelId],
        });
        return;
      }
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
    wouldExceedBudget(budget, { extraChoices: 1 }) &&
    !replaceSoleChoice;
  const modelCapBlocked = (checked: boolean) =>
    mode === "multiple" &&
    !checked &&
    wouldExceedBudget(budget, { extraChoices: 1 }) &&
    !replaceSoleChoice;

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
          {mode === "single" ? "Model" : "Models"}
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
          {availableModels.length === 0 && staleExplicit.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No catalog models available.
            </p>
          ) : (
            <>
            {availableModels.map((model) => {
              const id = String(model.id);
              const checked = explicit.includes(id);
              const locked = model.disabled === true;
              const capBlocked = modelCapBlocked(checked);
              // A persisted locked model must stay checkable so the user
              // can remove it. Lock and cap only block adding a new pick.
              const optionDisabled =
                disabled || (!checked && (locked || capBlocked));
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
            })}
            {staleExplicit.map((id) => (
              <Label
                key={id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/30"
                title="No longer in the catalog"
              >
                <Checkbox
                  checked
                  onCheckedChange={(next) => toggleModel(id, next === true)}
                  disabled={disabled}
                  aria-label={id}
                />
                <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
                  {id}
                </span>
              </Label>
            ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function modelsPillTriggerLabel(
  value: ModelSelection,
  options?: {
    /** Inherited model id or display name when Client defaults is the only pick. */
    clientDefaultLabel?: string | null;
    /** Resolve a catalog id (or already-display string) to a compact label. */
    modelName?: (id: string) => string;
  }
): string {
  const n = value.explicitModelIds.length;
  const inheritedRaw = options?.clientDefaultLabel?.trim() ?? "";
  const inherited = inheritedRaw
    ? options?.modelName?.(inheritedRaw) || inheritedRaw
    : "";
  if (value.includeClientDefaults && n === 0) return inherited || "models";
  if (value.includeClientDefaults && n > 0) {
    return inherited ? `${inherited} +${n}` : `models +${n}`;
  }
  if (n === 1) {
    const id = value.explicitModelIds[0];
    return options?.modelName?.(id) || "1 model";
  }
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

/**
 * At the product cap with exactly one current choice, adding any other
 * option is over budget — but replacing that sole choice stays within
 * the cap. The live composer commits each checkbox immediately, so
 * unchecking the current pick first yields zero choices and rolls back.
 * Offer the replacement as one commit instead of disabling every
 * alternative.
 */
function canReplaceSoleChoice(
  budget: TargetBudgetContext | undefined
): boolean {
  if (!budget) return false;
  return (
    budget.choiceCount === 1 &&
    budget.hostCount <= budget.maxTargets &&
    budget.hostCount * 2 > budget.maxTargets
  );
}
