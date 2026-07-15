/**
 * Pass criteria for the case-edit surface — a gear popover (same affordance
 * as suite settings) containing validators + checks overrides.
 *
 * The suite-edit page does NOT use this: that's the primary edit surface
 * where validators + checks are fully expanded inline.
 */

import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { Settings } from "lucide-react";
import {
  resolveMatchOptions,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import { CaseChecksSection } from "./checks-section";
import { ValidatorsSection } from "./validators-section";

export interface CasePassCriteriaPopoverProps {
  matchOptions: EvalMatchOptions | undefined;
  onMatchOptionsChange: (next: EvalMatchOptions | undefined) => void;
  suiteDefaultMatchOptions: EvalMatchOptions | undefined;

  predicates: CasePredicates | undefined;
  onPredicatesChange: (next: CasePredicates | undefined) => void;
  suiteDefaultPredicates: Predicate[];
  availableTools?: string[];
  onAppendScenarioToSteps?: (scenarioAsserts: Predicate[]) => void;
}

function hasValidatorOverride(value: EvalMatchOptions | undefined): boolean {
  if (!value) return false;
  return (
    value.toolCallOrder !== undefined ||
    value.maxExtraToolCalls !== undefined ||
    value.allowExtraToolCalls !== undefined ||
    value.argumentMatching !== undefined
  );
}

function hasChecksOverride(value: CasePredicates | undefined): boolean {
  return value !== undefined && value.mode !== "inherit";
}

export function isCasePassCriteriaOverridden(
  matchOptions: EvalMatchOptions | undefined,
  predicates: CasePredicates | undefined,
): boolean {
  return hasValidatorOverride(matchOptions) || hasChecksOverride(predicates);
}

export function CasePassCriteriaPopover({
  matchOptions,
  onMatchOptionsChange,
  suiteDefaultMatchOptions,
  predicates,
  onPredicatesChange,
  suiteDefaultPredicates,
  availableTools,
  onAppendScenarioToSteps,
}: CasePassCriteriaPopoverProps) {
  const resolvedMatch = resolveMatchOptions(suiteDefaultMatchOptions);
  const isOverridden = isCasePassCriteriaOverridden(matchOptions, predicates);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isOverridden) setOpen(true);
  }, [isOverridden]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="relative h-8 w-8 shrink-0 p-0"
              aria-label="Pass criteria"
              aria-expanded={open}
              data-testid="case-pass-criteria-toggle"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {isOverridden ? (
                <span
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                  data-testid="case-pass-criteria-overridden-badge"
                  aria-hidden
                />
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent
          variant="muted"
          side="bottom"
          align="end"
          sideOffset={6}
          className="px-2 py-1 text-[11px]"
        >
          {isOverridden
            ? "Pass criteria — overrides active"
            : "Pass criteria — validators and checks"}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-[min(32rem,90vw)] max-h-[min(36rem,70vh)] space-y-4 overflow-y-auto p-4"
        align="end"
        sideOffset={6}
      >
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Pass criteria</p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Override validators and checks for this case. Inherited values come
            from the suite defaults.
          </p>
          {isOverridden ? (
            <p
              className="text-xs font-medium text-primary"
              data-testid="case-pass-criteria-overridden-label"
            >
              Overridden
            </p>
          ) : null}
        </div>
        <ValidatorsSection
          title="Validators"
          description=""
          value={matchOptions}
          inheritedFrom={resolvedMatch}
          onChange={onMatchOptionsChange}
          showBadges
        />
        <div className="border-t border-border/40" />
        <CaseChecksSection
          value={predicates}
          onChange={onPredicatesChange}
          suiteDefaults={suiteDefaultPredicates}
          availableTools={availableTools}
          embedded
          onAppendScenarioToSteps={onAppendScenarioToSteps}
        />
      </PopoverContent>
    </Popover>
  );
}
