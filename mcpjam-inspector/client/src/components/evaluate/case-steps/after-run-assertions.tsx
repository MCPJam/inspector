/**
 * After-run assertions (DD1): the case's own assertions graded once over the
 * finished run, then the suite's defaults that also apply, folded away. Rows
 * are the case scorecard's `ScorecardRowView`, so they collapse to one line.
 */

import type { Predicate } from "@/shared/eval-matching";
import { SuiteScorerLibraryMenu } from "@/components/evals/suite-scorer-library-menu";
import {
  spineLibraryKinds,
  type CaseScorecard,
} from "../case-scorecard/case-scorecard-model";
import { ScorecardRowView } from "../case-scorecard/scorecard-row";
import { SuiteRowsDisclosure } from "../case-scorecard/suite-rows-disclosure";
import { afterTheRunRows } from "../case-spine/case-spine-model";
import { AFTER_RUN_ASSERTIONS_LABEL } from "./case-steps-model";
import { StepRail } from "./step-card";

export function AfterRunAssertions({
  card,
  ordinal,
  availableTools,
  readOnly,
  checkPolicy,
  authorableKinds,
  addedKey,
  onAdd,
  onChange,
  onOpenSuiteSettings,
}: {
  card: CaseScorecard;
  /** The number this section takes on the rail, after the last step. */
  ordinal: number;
  availableTools: string[];
  readOnly: boolean;
  checkPolicy: boolean;
  authorableKinds?: readonly Predicate["type"][];
  addedKey: string | null;
  onAdd: (kind: Predicate["type"]) => void;
  /** `null` removes the assertion at `index`. */
  onChange: (index: number, next: Predicate | null) => void;
  onOpenSuiteSettings?: () => void;
}) {
  const rows = afterTheRunRows(card);
  const own = rows.filter((row) => row.provenance === "case");
  const suite = rows.filter((row) => row.provenance === "suite");
  return (
    <StepRail
      marker={ordinal}
      label={`Step ${ordinal}`}
      testId="case-steps-after-run"
    >
      <section
        className="space-y-3 rounded-xl border border-border bg-card px-5 py-4"
        aria-labelledby="case-steps-after-run-heading"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3
              id="case-steps-after-run-heading"
              className="text-lg font-semibold text-card-foreground"
            >
              {AFTER_RUN_ASSERTIONS_LABEL}
            </h3>
            <p className="text-sm text-muted-foreground">
              Graded once, over the finished run.
            </p>
          </div>
          {readOnly ? null : (
            <SuiteScorerLibraryMenu
              kinds={spineLibraryKinds()}
              authorableKinds={authorableKinds}
              triggerLabel="Add assertion"
              onAdd={onAdd}
            />
          )}
        </div>
        {own.length > 0 ? (
          <ul className="space-y-1.5">
            {own.map((row) => {
              const index = row.predicateIndex;
              return (
                <ScorecardRowView
                  key={row.key}
                  row={row}
                  paper
                  availableTools={availableTools}
                  readOnly={readOnly}
                  checkPolicy={checkPolicy}
                  defaultOpen={addedKey === row.key}
                  newest={addedKey === row.key}
                  onOpenSuiteSettings={onOpenSuiteSettings}
                  onChangePredicate={
                    index === undefined
                      ? undefined
                      : (next) => onChange(index, next)
                  }
                  onRemove={
                    index === undefined
                      ? undefined
                      : () => onChange(index, null)
                  }
                />
              );
            })}
          </ul>
        ) : (
          <p
            className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground"
            data-testid="case-steps-after-run-empty"
          >
            No after-run assertions yet. Add one to grade the whole run, such as
            its total tool calls or its final answer.
          </p>
        )}
        {suite.length > 0 ? (
          <SuiteRowsDisclosure rows={suite}>
            <ul className="space-y-1.5">
              {suite.map((row) => (
                <ScorecardRowView
                  key={row.key}
                  row={row}
                  readOnly
                  checkPolicy={checkPolicy}
                  availableTools={availableTools}
                  onOpenSuiteSettings={onOpenSuiteSettings}
                />
              ))}
            </ul>
          </SuiteRowsDisclosure>
        ) : null}
      </section>
    </StepRail>
  );
}
