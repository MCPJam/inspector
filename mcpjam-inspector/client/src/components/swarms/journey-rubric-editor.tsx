import type React from "react";
import { useMemo } from "react";
import { Input } from "@mcpjam/design-system/input";
import { ChecksSection } from "@/components/evals/checks-section";
import { formatCriterion } from "@/shared/predicate-kinds";
import {
  MAX_RUBRIC_CRITERIA,
  reconcileRubricEntries,
  type JourneyCriterion,
} from "@/shared/journey-rubric";
import type { Predicate } from "@/shared/eval-matching";

/**
 * Rubric authoring for a journey — the deterministic half of "how is this
 * graded?", sitting beside the LLM judge in the form's Advanced block.
 *
 * Wraps the same `ChecksSection` the eval suite settings use, so the predicate
 * vocabulary and every field editor stay identical across surfaces, and layers
 * two things on top that only a rubric needs: a stable id per row, and an
 * optional human label.
 *
 * The id never surfaces in the UI. It exists so a row survives being
 * reordered, retuned, or renamed — see `reconcileRubricEntries`.
 */
export function JourneyRubricEditor({
  value,
  onChange,
}: {
  value: JourneyCriterion[];
  onChange: (next: JourneyCriterion[]) => void;
}) {
  // Stable across renders as long as the entries are: `ChecksSection` compares
  // by identity when the user edits a row, and a fresh array every render
  // would defeat the identity pass of the reconciler.
  const predicates = useMemo(
    () => value.map((entry) => entry.predicate),
    [value],
  );

  const atCap = value.length >= MAX_RUBRIC_CRITERIA;

  return (
    <div className="space-y-2">
      <ChecksSection
        value={predicates}
        onChange={(next: Predicate[]) =>
          onChange(reconcileRubricEntries(value, next))
        }
        title="Pass criteria"
        description="Deterministic checks run against every session in this journey. Each one becomes its own pass/fail column on the run scorecard and its own filter in Insights."
        // `hideAddButton`, NOT `readOnly`: `readOnly` disables per-row edit AND
        // remove, which would make the "Remove one to add another" message
        // below impossible to act on. At the cap, adding is what stops — the
        // rows already there stay fully editable.
        hideAddButton={atCap}
      />
      {atCap ? (
        <p className="text-[11px] text-muted-foreground">
          A rubric holds at most {MAX_RUBRIC_CRITERIA} criteria. Remove one to
          add another.
        </p>
      ) : null}
      {value.length > 0 ? (
        <div className="space-y-1.5 rounded-md border border-border/40 p-2">
          <p className="text-[11px] font-medium text-muted-foreground">
            Names (optional)
          </p>
          {value.map((entry, index) => (
            <div key={entry.id} className="flex items-center gap-2">
              <Input
                value={entry.label ?? ""}
                // The formatted predicate is the placeholder, not a prefilled
                // value: it shows what the row will be CALLED if left blank,
                // without turning a derived label into stored text that then
                // stops tracking the predicate.
                placeholder={formatCriterion({ predicate: entry.predicate })}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const next = [...value];
                  next[index] = { ...entry, label: e.target.value };
                  onChange(next);
                }}
                className="h-8 text-xs"
                aria-label={`Name for criterion ${index + 1}`}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
