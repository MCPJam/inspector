/**
 * What the steps editor reads from its suite: the facts its sections show and
 * the scorecard that grades a draft against the suite's defaults. Shared by the
 * saved case's page and the drafts that are not saved yet.
 */
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import { authorablePredicateKinds } from "@/components/evals/suite-scorer-table-model";
import type { EvalSuite } from "@/components/evals/types";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { Predicate } from "@/shared/eval-matching";
import {
  buildCaseScorecard,
  type CaseScorecard,
  type CaseScorecardInput,
} from "../case-scorecard/case-scorecard-model";
import type { CaseStepsDraft } from "./case-step-edits";
import type { CaseStepsEditorProps } from "./case-steps-editor";

export type JudgePolicy = CaseScorecardInput["judgePolicy"];

export function caseStepsScorecard(
  draft: CaseStepsDraft,
  suite: EvalSuite,
  judgePolicy: JudgePolicy,
): CaseScorecard {
  return buildCaseScorecard({
    steps: draft.steps,
    toolsChoice: draft.toolsChoice,
    kind: draft.kind,
    matchOptions: draft.matchOptions,
    suiteDefaultMatchOptions: suite.defaultMatchOptions,
    predicates: draft.predicates,
    suiteDefaultPredicates: (suite.defaultPredicates ?? []) as Predicate[],
    suppressedSuiteStandardCheckIds: draft.suppressedSuiteStandardCheckIds,
    expectedOutput: draft.expectedOutput,
    judgeConfigOverride: draft.judgeConfigOverride,
    suiteJudgeConfig: suite.judgeConfig,
    judgePolicy,
    suiteJudgeRubric: suite.judgeRubric,
    numbering: "action",
  });
}

export function caseStepsSuiteFacts(
  suite: EvalSuite,
  capabilities: SuiteCapabilities | null | undefined,
): CaseStepsEditorProps["suite"] {
  return {
    checkPolicy: capabilities?.scorers?.checkPolicy === true,
    authorableKinds: authorablePredicateKinds(
      capabilities?.scorers?.predicateKinds,
    ),
    name: stripTimestampSuffix(suite.name),
    judgeConfig: suite.judgeConfig,
    defaultPredicates: (suite.defaultPredicates ?? []) as Predicate[],
    servers: getEffectiveSuiteServers(suite),
    defaultMatchOptions: suite.defaultMatchOptions,
  };
}
