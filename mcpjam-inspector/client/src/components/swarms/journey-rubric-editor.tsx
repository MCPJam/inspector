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
  allowedKinds,
  maxCriteria = MAX_RUBRIC_CRITERIA,
}: {
  value: JourneyCriterion[];
  onChange: (next: JourneyCriterion[]) => void;
  /** Restrict the Add-check menu (existing rows of other kinds still render).
   * The swarm confirm step passes the swarm-level kinds; per-journey editors
   * leave it unset and offer everything. */
  allowedKinds?: readonly Predicate["type"][];
  /**
   * Effective cap, when the caller needs to RESERVE part of the rubric budget
   * for criteria stamped later. The swarm confirm step reserves room for each
   * journey's own suggested checks, which launch appends after the swarm-level
   * rows — without the reserve those journey checks are what the hard cap
   * silently drops. Never exceeds {@link MAX_RUBRIC_CRITERIA}, which the
   * backend enforces regardless.
   */
  maxCriteria?: number;
}) {
  // Stable across renders as long as the entries are: `ChecksSection` compares
  // by identity when the user edits a row, and a fresh array every render
  // would defeat the identity pass of the reconciler.
  const predicates = useMemo(
    () => value.map((entry) => entry.predicate),
    [value],
  );

  const cap = Math.max(0, Math.min(maxCriteria, MAX_RUBRIC_CRITERIA));
  const atCap = value.length >= cap;

  return (
    <div className="space-y-2">
      <ChecksSection
        value={predicates}
        onChange={(next: Predicate[]) =>
          onChange(reconcileRubricEntries(value, next))
        }
        title="Checks"
        // "Measure", never "gate": a failing check is a finding in Insights,
        // and nothing downstream blocks or fails because of it.
        // One line on purpose — this doubles as card-header copy on the
        // swarm confirm step.
        description="Each check is reported in the run scorecard and can surface as a finding in Insights."
        emptyStateText="No checks yet — add one to start measuring."
        allowedKinds={allowedKinds}
        // `hideAddButton`, NOT `readOnly`: `readOnly` disables per-row edit AND
        // remove, which would make the "Remove one to add another" message
        // below impossible to act on. At the cap, adding is what stops — the
        // rows already there stay fully editable.
        hideAddButton={atCap}
      />
      {atCap ? (
        <p className="text-[11px] text-muted-foreground">
          {/* A zero cap is reachable when the caller reserves the whole budget
              for checks stamped later, and there is then nothing to remove —
              so the actionable sentence would be advice the author cannot
              take. */}
          {cap === 0
            ? "No room for more checks in this launch."
            : `At most ${cap} checks — remove one to add another.`}
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
                aria-label={`Name for check ${index + 1}`}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
