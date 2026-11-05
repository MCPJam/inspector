import type { CasePredicates } from "@/shared/eval-matching";
import type { AvailableTool } from "@/components/evals/step-fields";
import type { PredicateKind } from "@/shared/predicate-kinds";
import type { EvalAddChoice } from "@/components/evals/eval-add-catalog";
import { ScorecardRowView } from "../case-scorecard/scorecard-row";
import { EvalAddDrawer } from "../case-spine/assertion-drawer";
import type { PreviewEndOfRun } from "./case-steps-model";

/**
 * The After-run assertions step: everything graded once over the finished
 * run, in the order the preview lists it (suite defaults, then the case's
 * own, then a frozen run's). Only the case's own rows are edited here; suite
 * defaults are edited in Suite settings.
 */
export function AfterRunStepBody({
  endOfRun,
  predicates,
  onPredicatesChange,
  availableTools,
  authorableKinds,
  checkPolicy,
  readOnly,
  onAdd,
  onOpenSuiteSettings,
}: {
  endOfRun: PreviewEndOfRun;
  predicates: CasePredicates | undefined;
  onPredicatesChange: (next: CasePredicates) => void;
  availableTools: AvailableTool[];
  authorableKinds: readonly PredicateKind[];
  checkPolicy: boolean;
  readOnly: boolean;
  onAdd: (choice: EvalAddChoice) => void;
  onOpenSuiteSettings: () => void;
}) {
  const toolNames = availableTools.map((tool) => tool.name);
  const writeList = (list: CasePredicates["list"]) =>
    onPredicatesChange({ mode: predicates?.mode ?? "extend", list });
  return (
    <div className="space-y-3">
      {endOfRun.assertions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No assertions run after the whole case yet.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="case-steps-after-run-rows">
          {endOfRun.assertions.map(({ row, provenance }) => {
            const own = provenance === "case" && row.predicateIndex != null;
            const index = row.predicateIndex ?? -1;
            return (
              <ScorecardRowView
                key={row.key}
                row={row}
                paper={!readOnly && own}
                readOnly={readOnly || !own}
                checkPolicy={checkPolicy}
                availableTools={toolNames}
                onOpenSuiteSettings={onOpenSuiteSettings}
                onChangePredicate={
                  own
                    ? (next) =>
                        writeList(
                          (predicates?.list ?? []).map((item, at) =>
                            at === index ? next : item,
                          ),
                        )
                    : undefined
                }
                onRemove={
                  own
                    ? () =>
                        writeList(
                          (predicates?.list ?? []).filter(
                            (_, at) => at !== index,
                          ),
                        )
                    : undefined
                }
              />
            );
          })}
        </ul>
      )}
      {endOfRun.replacedSuiteDefaults > 0 ? (
        <p className="text-sm text-muted-foreground">
          This case replaces {endOfRun.replacedSuiteDefaults} suite default
          {endOfRun.replacedSuiteDefaults === 1 ? "" : "s"}, so{" "}
          {endOfRun.replacedSuiteDefaults === 1 ? "it does" : "they do"} not
          run.
        </p>
      ) : null}
      {readOnly ? null : (
        <EvalAddDrawer
          wholeRunOnly
          allowWidgetChecks={false}
          authorableKinds={authorableKinds}
          triggerLabel="Add assertion"
          onSelect={onAdd}
        />
      )}
    </div>
  );
}
