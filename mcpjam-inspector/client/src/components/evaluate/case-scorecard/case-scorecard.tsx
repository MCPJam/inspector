/**
 * Scorers, for one case, in the order the chain grades them.
 *
 * Replaces "Check the result" — a Capability | Regression toggle, a tool
 * question, a rubric input, and a "More checks" drawer with three home-made
 * groups, one card per check and three separate Add menus. Everything that
 * grades this case is now one list, grouped the way the suite's Scorers table
 * groups it, with one library to add from.
 */

import { useMemo } from "react";
import type { Predicate } from "@/shared/eval-matching";
import { blankPredicate } from "@/shared/predicate-kinds";
import { PASS_OR_FAIL_HINT } from "@/components/evals/suite-pass-or-fail-section";
import { SuiteScorerLibraryMenu } from "@/components/evals/suite-scorer-library-menu";
import { ROLE_LEGEND } from "@/components/evals/suite-scorer-table-model";
import type { SimpleCaseOverlay } from "../simple-case/status-dot";
import type {
  CaseKind,
  SimpleCaseTool,
} from "../simple-case/simple-case-model";
import {
  buildCaseScorecard,
  caseLibraryKinds,
  type CaseScorecardInput,
} from "./case-scorecard-model";
import { ScorecardGroupSection } from "./scorecard-group";
import { ScorecardRowView } from "./scorecard-row";
import { RouteRow } from "./route-row";
import { JudgeBlock } from "./judge-block";

export const ROLE_LEGEND_LINE = `Gate ${ROLE_LEGEND.gate.meaning.toLowerCase().replace(/\.$/, "")} · Warn ${ROLE_LEGEND.warn.meaning.toLowerCase().replace(/\.$/, "")} · Report ${ROLE_LEGEND.report.meaning.toLowerCase().replace(/\.$/, "")}`;

export function CaseScorecard({
  input,
  availableTools,
  readOnly = false,
  checkPolicy = false,
  authorableKinds,
  overlay,
  validationAttempted = false,
  addedRowKey,
  onStepPredicateChange,
  onRemoveStep,
  onSelectStep,
  onCasePredicateChange,
  onRemoveCasePredicate,
  onAddScorer,
  onExpectedOutputChange,
  onJudgeSkippedChange,
  onOpenSuiteSettings,
  onSetTools,
  onChooseNoTool,
  onChooseTools,
  onAddTool,
  onSetKind,
}: {
  input: CaseScorecardInput;
  availableTools?: string[];
  readOnly?: boolean;
  checkPolicy?: boolean;
  /**
   * The kinds this DEPLOYMENT accepts. Offering one it rejects turns "Add
   * scorer" into a failed save; offering one an older RUNNER cannot evaluate
   * fails the check closed on every trial. The suite table has always
   * narrowed by this — the case page reaches the same library and must too.
   */
  authorableKinds?: readonly Predicate["type"][];
  overlay?: SimpleCaseOverlay | null;
  validationAttempted?: boolean;
  /** Row to open on mount — the one just added, so its fields are reachable. */
  addedRowKey?: string | null;
  onStepPredicateChange: (stepId: string, next: Predicate) => void;
  onRemoveStep: (stepId: string) => void;
  onSelectStep?: (stepId: string) => void;
  onCasePredicateChange: (index: number, next: Predicate) => void;
  onRemoveCasePredicate: (index: number) => void;
  onAddScorer: (predicate: Predicate) => void;
  onExpectedOutputChange: (next: string) => void;
  onJudgeSkippedChange?: (skipped: boolean) => void;
  onOpenSuiteSettings?: () => void;
  onSetTools: (tools: SimpleCaseTool[]) => void;
  onChooseNoTool: () => void;
  onChooseTools: () => void;
  onAddTool: (toolName: string) => void;
  onSetKind: (kind: CaseKind) => void;
}) {
  const card = useMemo(() => buildCaseScorecard(input), [input]);
  const showUnsetError = validationAttempted && card.unsetBlockReason !== null;

  return (
    <section className="space-y-4" data-testid="case-scorecard">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-[11px] font-medium text-foreground">Evaluators</h3>
          <p className="max-w-prose text-[11px] leading-snug text-muted-foreground">
            {PASS_OR_FAIL_HINT}
          </p>
        </div>
        {readOnly ? null : (
          <SuiteScorerLibraryMenu
            kinds={caseLibraryKinds()}
            authorableKinds={authorableKinds}
            onAdd={(kind) => onAddScorer(blankPredicate(kind))}
          />
        )}
      </div>

      {card.hiddenSuiteCount > 0 ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="case-scorecard-replaced"
        >
          Suite evaluators replaced for this case —{" "}
          {card.hiddenSuiteCount === 1
            ? "1 is not applied"
            : `${card.hiddenSuiteCount} are not applied`}
          .
        </p>
      ) : null}

      {card.groups.map((group) => (
        <ScorecardGroupSection
          key={group.stage}
          stage={group.stage}
          label={group.label}
          question={group.question}
        >
          {group.rows.map((row) => {
            if (row.provenance === "route") {
              return (
                <RouteRow
                  key={row.key}
                  row={row}
                  availableTools={availableTools}
                  readOnly={readOnly}
                  overlay={overlay}
                  showUnsetError={showUnsetError}
                  negativeContradiction={card.negativeContradiction}
                  onSetTools={onSetTools}
                  onChooseNoTool={onChooseNoTool}
                  onChooseTools={onChooseTools}
                  onAddTool={onAddTool}
                  onSetKind={onSetKind}
                />
              );
            }
            if (row.provenance === "judge") {
              return (
                <JudgeBlock
                  key={row.key}
                  row={row}
                  readOnly={readOnly}
                  onExpectedOutputChange={onExpectedOutputChange}
                  onSkippedChange={onJudgeSkippedChange}
                  onOpenSuiteSettings={onOpenSuiteSettings}
                />
              );
            }
            const stepId = row.stepId;
            const index = row.predicateIndex;
            return (
              <ScorecardRowView
                key={row.key}
                row={row}
                availableTools={availableTools}
                readOnly={readOnly}
                checkPolicy={checkPolicy}
                overlay={overlay}
                defaultOpen={addedRowKey === row.key}
                onChangePredicate={
                  row.provenance === "step" && stepId
                    ? (next) => onStepPredicateChange(stepId, next)
                    : row.provenance === "case" && index !== undefined
                      ? (next) => onCasePredicateChange(index, next)
                      : undefined
                }
                onRemove={
                  row.provenance === "step" && stepId
                    ? () => onRemoveStep(stepId)
                    : row.provenance === "case" && index !== undefined
                      ? () => onRemoveCasePredicate(index)
                      : undefined
                }
                onSelect={
                  stepId && onSelectStep ? () => onSelectStep(stepId) : undefined
                }
                onOpenSuiteSettings={onOpenSuiteSettings}
              />
            );
          })}
        </ScorecardGroupSection>
      ))}
    </section>
  );
}
