/**
 * Checks that depend on no single action, and the judge.
 *
 * These grade the finished transcript, all at the same moment. The suite's
 * settings table groups them by chain stage because there the question is
 * "what grades selection?"; here they run together and the grouping would be
 * chrome over a two-row list, so they render in the order the author wrote
 * them.
 */

import { Button } from "@mcpjam/design-system/button";
import { blankPredicate } from "@/shared/predicate-kinds";
import type { Predicate } from "@/shared/eval-matching";
import { SuiteScorerLibraryMenu } from "@/components/evals/suite-scorer-library-menu";
import {
  caseLibraryKinds,
  type CaseScorecard,
} from "../case-scorecard/case-scorecard-model";
import { ScorecardRowView } from "../case-scorecard/scorecard-row";
import { JudgeBlock } from "../case-scorecard/judge-block";
import { afterTheRunRows } from "./case-spine-model";

export function AfterTheRunSection({
  card,
  availableTools,
  readOnly,
  checkPolicy,
  addedKey,
  onCasePredicateChange,
  onRemoveCasePredicate,
  onAddScorer,
  onApplySuiteScorers,
  onExpectedOutputChange,
  onJudgeSkippedChange,
  onOpenSuiteSettings,
}: {
  card: CaseScorecard;
  availableTools?: string[];
  readOnly: boolean;
  checkPolicy: boolean;
  addedKey: string | null;
  onCasePredicateChange: (index: number, next: Predicate) => void;
  onRemoveCasePredicate: (index: number) => void;
  onAddScorer: (predicate: Predicate) => void;
  /** Absent when the case is not replacing the suite's scorers. */
  onApplySuiteScorers?: () => void;
  onExpectedOutputChange: (next: string) => void;
  onJudgeSkippedChange?: (skipped: boolean) => void;
  onOpenSuiteSettings?: () => void;
}) {
  const rows = afterTheRunRows(card);

  return (
    <section className="space-y-2" data-testid="spine-after-the-run">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-[11px] font-medium text-foreground">
            After the run
          </h3>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Graded once, over the finished transcript.
          </p>
        </div>
        {readOnly ? null : (
          <SuiteScorerLibraryMenu
            kinds={caseLibraryKinds()}
            triggerLabel="Add a check on the whole run"
            onAdd={(kind) => onAddScorer(blankPredicate(kind))}
          />
        )}
      </div>

      {card.hiddenSuiteCount > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"
          data-testid="case-scorecard-replaced"
        >
          <span>
            Suite scorers replaced for this case —{" "}
            {card.hiddenSuiteCount === 1
              ? "1 is not applied"
              : `${card.hiddenSuiteCount} are not applied`}
            .
          </span>
          {/* Without this the case is stuck: the gear that could switch the
              envelope back to `extend` is gone from this surface, and every
              writer here deliberately preserves `replace`. */}
          {readOnly || !onApplySuiteScorers ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={onApplySuiteScorers}
            >
              Apply suite scorers too
            </Button>
          )}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="space-y-1.5">
          {rows.map((row) => {
            const index = row.predicateIndex;
            const editable = row.provenance === "case" && index !== undefined;
            return (
              <ScorecardRowView
                key={row.key}
                row={row}
                availableTools={availableTools}
                readOnly={readOnly}
                checkPolicy={checkPolicy}
                defaultOpen={addedKey === row.key}
                onChangePredicate={
                  editable
                    ? (next) => onCasePredicateChange(index!, next)
                    : undefined
                }
                onRemove={
                  editable ? () => onRemoveCasePredicate(index!) : undefined
                }
                onOpenSuiteSettings={onOpenSuiteSettings}
              />
            );
          })}
        </ul>
      ) : null}

      <ul className="space-y-1.5">
        <JudgeBlock
          row={card.judge}
          readOnly={readOnly}
          onExpectedOutputChange={onExpectedOutputChange}
          onSkippedChange={onJudgeSkippedChange}
          onOpenSuiteSettings={onOpenSuiteSettings}
        />
      </ul>
    </section>
  );
}
