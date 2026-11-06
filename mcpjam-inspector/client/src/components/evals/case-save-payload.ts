/**
 * What a test case editor sends to `createTestCase` and `updateTestCase`.
 *
 * Both editors (today's `test-template-editor.tsx` and the Evaluate steps
 * editor) build the body here, so a saved case looks the same whichever one
 * wrote it. The caller decides `isNegativeTest`: the steps editor reads the
 * author's tool answer, the old editor keeps its own rule.
 */
import { useMutation } from "convex/react";
import { collectUniqueModelsFromTestCases } from "@/lib/evals/collect-unique-suite-models";
import type { CasePredicates, EvalMatchOptions } from "@/shared/eval-matching";
import {
  deriveExpectedToolCalls,
  deriveQuery,
  stripPromptTurnsFromAdvancedConfig,
  type TestStep,
} from "@/shared/steps";
import { normalizeToolChoice } from "@/shared/tool-choice";
import { DEFAULTS } from "./constants";
import type { EvalCase, EvalJudgeConfigOverride } from "./types";

export interface CaseSaveForm {
  title: string;
  runs: number;
  scenario?: string;
  steps: TestStep[];
  advancedConfig?: Record<string, unknown>;
  matchOptions?: EvalMatchOptions;
  /** Case-level predicate gate override; undefined ⇒ inherit suite defaults. */
  predicates?: CasePredicates;
  suppressedSuiteStandardCheckIds?: string[];
  /** Authored rubric for the model judge. Empty string clears it. */
  expectedOutput?: string;
  /**
   * The one per-case judge override the backend admits: opt out. No per-case
   * model, threshold or role exists to write.
   */
  judgeConfigOverride?: EvalJudgeConfigOverride;
  kind?: "capability" | "regression";
}

export function normalizeAdvancedConfig(
  advancedConfig: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const stripped = stripPromptTurnsFromAdvancedConfig(advancedConfig);
  if (!stripped) {
    return undefined;
  }

  const next = { ...stripped };

  if (typeof next.system === "string" && next.system.trim() === "") {
    delete next.system;
  }
  const normalizedToolChoice = normalizeToolChoice(next.toolChoice);
  if (!normalizedToolChoice) {
    delete next.toolChoice;
  } else {
    next.toolChoice = normalizedToolChoice;
  }
  if (
    next.temperature === null ||
    next.temperature === undefined ||
    next.temperature === ""
  ) {
    delete next.temperature;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function buildCaseSavePayload(
  form: CaseSaveForm,
  opts: { isNegativeTest: boolean },
) {
  const { isNegativeTest } = opts;
  // `query`/`expectedToolCalls` are denormalized display projections of
  // `steps` (the runner reads `steps`, never these). A negative test expects
  // no model tool calls, so its flattened display list is empty.
  const steps = form.steps;
  const query = deriveQuery(steps);
  const expectedToolCalls = isNegativeTest
    ? []
    : deriveExpectedToolCalls(steps);

  // Normalize the predicate envelope before it crosses the wire. The
  // in-memory editForm keeps a draft `list` in `inherit` mode so the
  // user can flip back to `replace`/`extend` without losing their work,
  // but the persisted envelope must carry an empty list there — the
  // runner ignores it AND `casePredicatesSchema` still validates each
  // row with `predicateSchema` regardless of mode, so a stale invalid
  // row would be rejected downstream even though the case is "safe".
  const normalizedPredicates = form.predicates
    ? form.predicates.mode === "inherit"
      ? { ...form.predicates, list: [] }
      : form.predicates
    : form.predicates;

  return {
    title: form.title,
    runs: form.runs,
    scenario: form.scenario?.trim() ? form.scenario.trim() : undefined,
    query,
    expectedToolCalls,
    // Authored rubric for the model judge. Send "" to clear — the backend
    // preserves the field on omit, and the judge trims "" to absent.
    expectedOutput: form.expectedOutput?.trim() ?? "",
    steps,
    isNegativeTest,
    advancedConfig: normalizeAdvancedConfig(form.advancedConfig),
    matchOptions: form.matchOptions,
    predicates: normalizedPredicates,
    suppressedSuiteStandardCheckIds: form.suppressedSuiteStandardCheckIds ?? [],
    // Omitted when undefined: `createTestCase` admits no `null` for this
    // field, and `handleSave` supplies the null-clear on the update path.
    ...(form.judgeConfigOverride !== undefined
      ? { judgeConfigOverride: form.judgeConfigOverride }
      : {}),
    ...(form.kind !== undefined ? { kind: form.kind } : {}),
  };
}

export type CaseSavePayload = ReturnType<typeof buildCaseSavePayload>;

/**
 * In-memory shape for an unsaved ("draft") case, so the editor can render it
 * before anything is written to Convex. Mirrors the fields the old eager-create
 * handlers inserted. `_id` is the route sentinel (`draft:<kind>`), not a real
 * Convex id — Save swaps the eager update for a `createTestCase` insert.
 */
export type DraftTestCase = Pick<
  EvalCase,
  "_id" | "title" | "query" | "runs" | "models"
> & { caseType: "prompt" };

export function buildDraftTestCase(
  id: string,
  suiteTestCases: EvalCase[] | undefined,
): DraftTestCase {
  const collected = collectUniqueModelsFromTestCases(suiteTestCases ?? []);
  const models =
    collected.length > 0
      ? collected
      : [{ provider: "anthropic", model: "anthropic/claude-haiku-4.5" }];
  return {
    _id: id,
    title: "Untitled test case",
    query: "",
    runs: DEFAULTS.RUNS_PER_TEST,
    models,
    caseType: "prompt",
  };
}

export type UpdateTestCaseArgs = {
  testCaseId: string;
  [key: string]: unknown;
};

/**
 * The two case mutations, typed once. The client has no generated Convex
 * api, so the string-name cast lives here instead of in each editor.
 */
export function useCaseSaveMutations() {
  const updateTestCase = useMutation(
    "testSuites:updateTestCase" as any,
  ) as unknown as (args: UpdateTestCaseArgs) => Promise<unknown>;
  const createTestCase = useMutation(
    "testSuites:createTestCase" as any,
  ) as unknown as (args: Record<string, unknown>) => Promise<string>;
  return { updateTestCase, createTestCase };
}
