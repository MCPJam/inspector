/**
 * Test Case Evaluators: the case's overrides of the suite's evaluators, on
 * their own page under the case. The table is `CaseChecksPage`, the same one
 * the old editor shows; changes save as they are made, in order.
 */

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { resolveMatchOptions } from "@/shared/eval-matching";
import { useSuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { areAllChecksValid } from "@/components/evals/checks-section";
import type { StandardCheckDraft } from "@/components/evals/standard-checks-model";
import { CaseChecksPage } from "../case-workspace/case-checks-page";
import { EvalHeaderActions, EvalHeaderBack } from "../nav/eval-header-actions";
import { withCaseJudgeSkipped } from "../case-scorecard/case-scorecard-model";
import type { CaseStepsDraft } from "./case-steps-draft";

type EvaluatorFields = Pick<
  CaseStepsDraft,
  "predicates" | "suppressedSuiteStandardCheckIds" | "judgeConfigOverride"
>;

const updateEvaluatorsRef = makeFunctionReference<
  "mutation",
  {
    testCaseId: string;
    predicates: EvaluatorFields["predicates"] | null;
    suppressedSuiteStandardCheckIds: string[];
    judgeConfigOverride: EvaluatorFields["judgeConfigOverride"] | null;
  },
  unknown
>("testSuites:updateTestCase");

export function CaseEvaluatorsPage({
  suite,
  testCase,
  readOnly,
  back,
  onConfigureSuite,
}: {
  suite: EvalSuite;
  testCase: EvalCase;
  readOnly: boolean;
  back: { label: string; onClick: () => void };
  onConfigureSuite: () => void;
}) {
  const updateTestCase = useMutation(updateEvaluatorsRef);
  const { capabilities } = useSuiteCapabilities(suite._id);
  const [fields, setFields] = useState<EvaluatorFields>(() => ({
    predicates: testCase.predicates,
    suppressedSuiteStandardCheckIds: testCase.suppressedSuiteStandardCheckIds,
    judgeConfigOverride: testCase.judgeConfigOverride,
  }));
  const [status, setStatus] = useState<string | null>(null);
  // Saves run one after another, so a slow one never lands after a newer one.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);

  const change = (patch: Partial<EvaluatorFields>) => {
    if (readOnly) return;
    const next = { ...fields, ...patch };
    setFields(next);
    const list = next.predicates;
    if (list && list.mode !== "inherit" && !areAllChecksValid(list.list)) {
      setStatus("Complete the assertion fields to save your changes.");
      return;
    }
    const mine = ++revision.current;
    setStatus("Saving…");
    queue.current = queue.current.then(async () => {
      try {
        await updateTestCase({
          testCaseId: testCase._id,
          predicates: next.predicates ?? null,
          suppressedSuiteStandardCheckIds:
            next.suppressedSuiteStandardCheckIds ?? [],
          judgeConfigOverride: next.judgeConfigOverride ?? null,
        });
        if (mine === revision.current) setStatus(null);
      } catch {
        if (mine === revision.current)
          setStatus("Your last change wasn’t saved. Change it again to retry.");
      }
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <EvalHeaderActions>
        <EvalHeaderBack label={back.label} onClick={back.onClick} />
      </EvalHeaderActions>
      <CaseChecksPage
        title={testCase.title}
        predicates={fields.predicates}
        suppressedSuiteStandardCheckIds={fields.suppressedSuiteStandardCheckIds}
        suitePredicates={suite.defaultPredicates ?? []}
        matchOptions={resolveMatchOptions(
          suite.defaultMatchOptions,
          testCase.matchOptions,
        )}
        suiteJudgeConfig={suite.judgeConfig}
        capabilities={capabilities}
        saveStatus={status}
        onChecksChange={(next: StandardCheckDraft) => change(next)}
        judgeSkipped={
          fields.judgeConfigOverride?.goalCompletion?.enabled === false
        }
        onJudgeSkippedChange={(skipped) =>
          change({
            judgeConfigOverride: withCaseJudgeSkipped(
              fields.judgeConfigOverride,
              skipped,
            ),
          })
        }
        onConfigureSuite={onConfigureSuite}
      />
    </div>
  );
}
