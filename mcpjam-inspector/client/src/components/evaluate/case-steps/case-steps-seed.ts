/**
 * The editor's draft from a stored case, and whether the draft has changed
 * since. The comparison is today's editor's (hasUnsavedChanges): normalized
 * steps, title, runs, scenario, outcome, config, envelopes, kind, the judge
 * opt-out and the negative flag the draft would save.
 */
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import {
  caseAccountsChanged,
  normalizeAdvancedConfig,
} from "@/components/evals/case-save-payload";
import { DEFAULTS } from "@/components/evals/constants";
import { loadCaseSteps } from "@/components/evals/load-case-steps";
import type { EvalCase } from "@/components/evals/types";
import type { CasePredicates } from "@/shared/eval-matching";
import { newStepId } from "@/shared/steps";
import {
  initialToolsChoice,
  readSimpleCase,
} from "../simple-case/simple-case-model";
import type { CaseStepsDraft } from "./case-step-edits";

export function seedCaseStepsDraft(testCase: EvalCase): CaseStepsDraft {
  const steps = loadCaseSteps(testCase);
  const tools = readSimpleCase(steps).tools;
  return {
    title: testCase.title,
    runs: testCase.runs ?? DEFAULTS.RUNS_PER_TEST,
    scenario: testCase.scenario ?? "",
    steps,
    advancedConfig: normalizeAdvancedConfig(testCase.advancedConfig),
    matchOptions: testCase.matchOptions,
    predicates: testCase.predicates,
    suppressedSuiteStandardCheckIds: testCase.suppressedSuiteStandardCheckIds,
    expectedOutput: testCase.expectedOutput ?? "",
    judgeConfigOverride: testCase.judgeConfigOverride,
    kind: testCase.kind,
    toolsChoice: initialToolsChoice({
      tools,
      isNegativeTest: testCase.isNegativeTest,
    }),
    // Only No tools fills the stash, from the steps it removes.
    stashedTools: [],
  };
}

/** A New case: one empty prompt, and the tool question not answered yet. */
export function blankCaseStepsDraft(
  title: string,
  runs: number,
): CaseStepsDraft {
  return {
    title,
    runs,
    scenario: "",
    steps: [{ id: newStepId("prompt"), kind: "prompt", prompt: "" }],
    expectedOutput: "",
    toolsChoice: "unset",
    stashedTools: [],
  };
}

/**
 * JSON with sorted keys, where a key set to undefined matches a missing one:
 * Convex drops undefined fields on save, so `{ serverId: undefined }` must
 * match the `{}` that comes back. An explicit null inside an object is kept,
 * since it can be a real edit; at the top, null and undefined are equal.
 */
const stable = (value: unknown) => stableStringifyJson(value ?? null);

/** None when it grades like no envelope: inherit, or extend with no rows. */
function ownEnvelope(predicates: CasePredicates | undefined) {
  if (!predicates || predicates.mode === "inherit") return undefined;
  const empty = predicates.mode === "extend" && predicates.list.length === 0;
  return empty ? undefined : predicates;
}

export function isCaseStepsDirty(
  draft: CaseStepsDraft,
  testCase: EvalCase,
): boolean {
  const pairs: [unknown, unknown][] = [
    [draft.title, testCase.title],
    [draft.runs, testCase.runs ?? DEFAULTS.RUNS_PER_TEST],
    [(draft.scenario ?? "").trim(), (testCase.scenario ?? "").trim()],
    [draft.steps, loadCaseSteps(testCase)],
    [
      draft.advancedConfig ?? {},
      normalizeAdvancedConfig(testCase.advancedConfig) ?? {},
    ],
    [draft.matchOptions, testCase.matchOptions],
    [
      [
        ownEnvelope(draft.predicates),
        draft.suppressedSuiteStandardCheckIds ?? [],
      ],
      [
        ownEnvelope(testCase.predicates),
        testCase.suppressedSuiteStandardCheckIds ?? [],
      ],
    ],
    [draft.expectedOutput.trim(), (testCase.expectedOutput ?? "").trim()],
    [draft.kind, testCase.kind],
    [draft.judgeConfigOverride, testCase.judgeConfigOverride],
    [draft.toolsChoice === "noTool", testCase.isNegativeTest ?? false],
  ];
  return (
    caseAccountsChanged(draft, testCase) ||
    pairs.some(([a, b]) => stable(a) !== stable(b))
  );
}
