/**
 * Collapsible "Pass criteria" section for the case-edit surface.
 *
 * Wraps {@link ValidatorsSection} and {@link CaseChecksSection} behind a
 * single disclosure. The case editor is an override surface — almost every
 * field inherits from the suite — so the default state is collapsed.
 * Authors who want to override expand the section and edit in place; an
 * "Overridden" badge appears on the collapsed header whenever any field
 * diverges from the suite default, so divergence stays visible at a glance.
 *
 * The suite-edit page does NOT use this wrapper: that's the primary edit
 * surface, where validators + checks should be fully expanded.
 */

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  resolveMatchOptions,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import { CaseChecksSection } from "./checks-section";
import { ValidatorsSection } from "./validators-section";

interface CasePassCriteriaSectionProps {
  matchOptions: EvalMatchOptions | undefined;
  onMatchOptionsChange: (next: EvalMatchOptions | undefined) => void;
  suiteDefaultMatchOptions: EvalMatchOptions | undefined;

  predicates: CasePredicates | undefined;
  onPredicatesChange: (next: CasePredicates | undefined) => void;
  suiteDefaultPredicates: Predicate[];

  availableTools?: string[];
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

export function CasePassCriteriaSection({
  matchOptions,
  onMatchOptionsChange,
  suiteDefaultMatchOptions,
  predicates,
  onPredicatesChange,
  suiteDefaultPredicates,
  availableTools,
}: CasePassCriteriaSectionProps) {
  const resolvedMatch = resolveMatchOptions(suiteDefaultMatchOptions);

  const isOverridden =
    hasValidatorOverride(matchOptions) || hasChecksOverride(predicates);

  // Default collapsed when fully inherited; default open when the case
  // overrides anything. Once mounted, leave open/closed up to the user — we
  // don't snap it shut on reset because that hides their editing context.
  const [open, setOpen] = useState<boolean>(isOverridden);

  // If a parent state change pushes this case into overridden territory
  // (e.g. preset applied), pop the section open so the change is visible.
  useEffect(() => {
    if (isOverridden) setOpen(true);
  }, [isOverridden]);

  return (
    <div className="rounded-lg border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-3 text-left",
          "hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "rounded-t-lg" : "rounded-lg",
        )}
        data-testid="case-pass-criteria-toggle"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-0" : "-rotate-90",
          )}
          aria-hidden
        />
        <span className="text-sm font-medium text-foreground">
          Pass criteria
        </span>
        {isOverridden ? (
          <span
            className="text-xs font-medium text-primary"
            data-testid="case-pass-criteria-overridden-badge"
          >
            Overridden
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="space-y-5 border-t border-border/60 px-4 pb-4 pt-3">
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
          />
        </div>
      ) : null}
    </div>
  );
}
