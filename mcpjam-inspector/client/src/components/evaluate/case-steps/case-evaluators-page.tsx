/**
 * Test Case Evaluators (C9): the case's overrides of the suite's default
 * evaluators, at Suite settings › Test cases › case › Test Case Evaluators.
 * It shares the steps editor's draft, header and save, and reuses the
 * evaluator table the old editor shows behind `?checks=1`.
 */

import { ListChecks, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { resolveMatchOptions, type Predicate } from "@/shared/eval-matching";
import { CaseChecksPage } from "../case-workspace/case-checks-page";
import { withCaseJudgeSkipped } from "../case-scorecard/case-scorecard-model";
import { CasePageHeader } from "./case-page-header";
import { useCaseEditorDraft } from "./use-case-editor-draft";
import {
  caseBackTarget,
  useEvaluateNavGo,
  type CaseEvaluatorsRoute,
} from "./case-editor-nav";

export function CaseEvaluatorsPage({ route }: { route: CaseEvaluatorsRoute }) {
  const { suiteId, caseId } = route;
  const go = useEvaluateNavGo();
  const state = useCaseEditorDraft(suiteId, caseId);
  const { draft, suite, testCase } = state;
  const { capabilities } = useSuiteCapabilities(suiteId);
  const back = caseBackTarget(route);

  if (state.status === "missing" || suite === null) {
    return (
      <div className="p-6">
        <EmptyState
          icon={ListChecks}
          title="Test case not found"
          description="This suite has no test case at this address. Go back to pick one."
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => go(back.route, "back")}
          >
            {back.label}
          </Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="case-evaluators-page"
    >
      <CasePageHeader
        route={route}
        names={{ suiteName: suite?.name, caseName: draft?.title }}
        back={back}
        onNavigate={go}
        title={
          <h1 className="truncate text-lg font-semibold">
            {draft?.title ?? "Test case"}
          </h1>
        }
        actions={
          <Button
            type="button"
            size="sm"
            disabled={!draft || !state.isDirty || state.isSaving}
            onClick={() => void state.save()}
          >
            {state.isSaving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Save
          </Button>
        }
      />
      {draft && suite ? (
        <CaseChecksPage
          title={draft.title}
          predicates={draft.predicates}
          suppressedSuiteStandardCheckIds={
            draft.suppressedSuiteStandardCheckIds
          }
          suitePredicates={(suite.defaultPredicates ?? []) as Predicate[]}
          matchOptions={resolveMatchOptions(
            suite.defaultMatchOptions,
            testCase?.matchOptions,
          )}
          suiteJudgeConfig={suite.judgeConfig}
          capabilities={capabilities}
          onChecksChange={(next) =>
            state.update({
              predicates: next.predicates,
              suppressedSuiteStandardCheckIds:
                next.suppressedSuiteStandardCheckIds,
            })
          }
          judgeSkipped={
            draft.judgeConfigOverride?.goalCompletion?.enabled === false
          }
          onJudgeSkippedChange={(skipped) =>
            state.update({
              judgeConfigOverride: withCaseJudgeSkipped(
                draft.judgeConfigOverride,
                skipped,
              ),
            })
          }
          onConfigureSuite={() =>
            go({ type: "suite-settings", suiteId, tab: "evaluators" }, "link")
          }
        />
      ) : (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" aria-label="Loading" />
        </div>
      )}
    </div>
  );
}
