/**
 * The editor's draft from a stored case, and whether the draft has changed
 * since. The comparison is today's editor's (hasUnsavedChanges): normalized
 * steps, title, scenario, outcome, config, envelopes, kind, the judge opt-out
 * and the negative flag the draft would save.
 */
import { normalizeAdvancedConfig } from "@/components/evals/case-save-payload";
import { DEFAULTS } from "@/components/evals/constants";
import { loadCaseSteps } from "@/components/evals/load-case-steps";
import type { EvalCase } from "@/components/evals/types";
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
    stashedTools: tools,
  };
}

/** A New case: one empty User prompt, nothing else. */
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

/** JSON with sorted keys; null and undefined compare equal. */
function stable(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || item === undefined) return null;
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, normalize(record[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function isCaseStepsDirty(
  draft: CaseStepsDraft,
  testCase: EvalCase,
): boolean {
  const pairs: [unknown, unknown][] = [
    [draft.title, testCase.title],
    [(draft.scenario ?? "").trim(), (testCase.scenario ?? "").trim()],
    [draft.steps, loadCaseSteps(testCase)],
    [
      draft.advancedConfig ?? {},
      normalizeAdvancedConfig(testCase.advancedConfig) ?? {},
    ],
    [draft.matchOptions, testCase.matchOptions],
    [
      [draft.predicates, draft.suppressedSuiteStandardCheckIds ?? []],
      [testCase.predicates, testCase.suppressedSuiteStandardCheckIds ?? []],
    ],
    [draft.expectedOutput.trim(), (testCase.expectedOutput ?? "").trim()],
    [draft.kind, testCase.kind],
    [draft.judgeConfigOverride, testCase.judgeConfigOverride],
    [draft.toolsChoice === "noTool", testCase.isNegativeTest ?? false],
  ];
  return pairs.some(([a, b]) => stable(a) !== stable(b));
}
