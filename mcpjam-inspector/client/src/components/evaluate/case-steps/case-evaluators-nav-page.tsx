/**
 * Test Case Evaluators: today's CaseChecksPage, unchanged, fed from the same
 * draft as the editor and saved as each change is made.
 */
import type { Predicate } from "@/shared/eval-matching";
import { resolveMatchOptions } from "@/shared/eval-matching";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import { CaseChecksPage } from "../case-workspace/case-checks-page";
import { withCaseJudgeSkipped } from "../case-scorecard/case-scorecard-model";
import { EvalCrumbBar } from "../evals-header";
import { useEvalNavPageView } from "../nav/eval-nav-analytics";
import {
  buildEvalBack,
  buildEvalCrumbs,
  type EvalNavNames,
} from "../nav/eval-nav-crumbs";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { useEvalNavArrival, useEvalNavigate } from "../nav/eval-nav-state";
import { MissingCase } from "./case-steps-page";
import { useCaseStepsDraft } from "./use-case-steps-draft";

export function CaseEvaluatorsNavPage({ route, projectId }: EvalNavPageProps) {
  if (route.type !== "case-evaluators") return null;
  return <CaseEvaluatorsPage route={route} projectId={projectId} />;
}

function CaseEvaluatorsPage({
  route,
  projectId,
}: {
  route: Extract<EvalNavPageProps["route"], { type: "case-evaluators" }>;
  projectId: string | null;
}) {
  const data = useCaseStepsDraft({
    suiteId: route.suiteId,
    testCaseId: route.testCaseId,
  });
  const names: EvalNavNames = {
    suiteName: data.suite ? stripTimestampSuffix(data.suite.name) : undefined,
    testCaseTitle: data.testCase?.title,
  };
  const { from } = useEvalNavArrival();
  const navigate = useEvalNavigate();
  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });
  const openSettings = (tab: "cases" | "evaluators") =>
    navigate(
      { type: "suite-settings", suiteId: route.suiteId, tab },
      { via: "link", from: { route, names } },
    );

  const { draft, suite } = data;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EvalCrumbBar
        crumbs={buildEvalCrumbs(route, names) ?? []}
        back={buildEvalBack(route, names, from)}
      />
      {data.status === "missing" ? (
        <MissingCase onOpen={() => openSettings("cases")} />
      ) : draft && suite ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-6 sm:px-6">
          <CaseChecksPage
            title={draft.title}
            predicates={draft.predicates}
            suppressedSuiteStandardCheckIds={
              draft.suppressedSuiteStandardCheckIds
            }
            suitePredicates={(suite.defaultPredicates ?? []) as Predicate[]}
            matchOptions={resolveMatchOptions(
              suite.defaultMatchOptions,
              draft.matchOptions,
            )}
            suiteJudgeConfig={suite.judgeConfig}
            capabilities={data.capabilities}
            saveStatus={data.checksSaveStatus}
            onChecksChange={(next) => {
              data.setDraft((current) => ({ ...current, ...next }));
              data.saveChecks({
                predicates: next.predicates,
                suppressedSuiteStandardCheckIds:
                  next.suppressedSuiteStandardCheckIds ?? [],
              });
            }}
            judgeSkipped={
              draft.judgeConfigOverride?.goalCompletion?.enabled === false
            }
            onJudgeSkippedChange={(skipped) => {
              const judgeConfigOverride = withCaseJudgeSkipped(
                draft.judgeConfigOverride,
                skipped,
              );
              data.setDraft((current) => ({ ...current, judgeConfigOverride }));
              data.saveChecks({ judgeConfigOverride });
            }}
            onConfigureSuite={() => openSettings("evaluators")}
          />
        </div>
      ) : null}
    </div>
  );
}
