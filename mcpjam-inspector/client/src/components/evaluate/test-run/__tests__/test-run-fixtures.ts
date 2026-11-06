/** The sample test run: Excalidraw quickstart, Run #4, a two-model launch. */
import { USER_VALUE_STAGES, type UserValueStage } from "@mcpjam/sdk/contract";
import type { Predicate } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../../../evals/types";
import type { EvaluateCaseRow } from "../../evaluate-case-row-model";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import { buildTestRunFindings } from "../test-run-findings-model";
import type { TestRunScorecard } from "../test-run-scorecard-model";

export const NOW = Date.UTC(2026, 10, 5, 12);
const DAY = 86_400_000;

export const CASE_ID = "case-sketch";
export const CASE_TITLE = "Sketch a two-node flow";

export function fixtureRun(
  id: string,
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-excalidraw",
    runGroupId: "launch-4",
    runNumber: 4,
    status: "completed",
    effectiveModelId: "openai/gpt-5-mini",
    client: { name: "MCPJam", source: "suite_default" },
    createdAt: NOW - 13 * DAY,
    configSnapshot: {
      tests: [{ title: CASE_TITLE, query: "", testCaseId: CASE_ID }],
      environment: { servers: [] },
    },
    ...overrides,
  } as EvalSuiteRun;
}

export function fixtureIteration(
  id: string,
  runId: string,
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: CASE_ID,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    tokensUsed: 2000,
    actualToolCalls: [],
    iterationNumber: 1,
    createdAt: NOW - 13 * DAY,
    startedAt: NOW - 13 * DAY,
    updatedAt: NOW - 13 * DAY + 13_000,
    testCaseSnapshot: {
      title: CASE_TITLE,
      model: "openai/gpt-5-mini",
      provider: "openai",
      query: "Sketch a tiny flow",
      expectedToolCalls: [],
    },
    ...overrides,
  } as EvalIteration;
}

export const RUN_A = fixtureRun("run-a");
export const RUN_B = fixtureRun("run-b", {
  runNumber: 5,
  effectiveModelId: "anthropic/claude-haiku-4.5",
});

const start = NOW - 13 * DAY;
const mini = (
  n: number,
  result: EvalIteration["result"],
  seconds: number,
  status: EvalIteration["status"] = "completed",
) =>
  fixtureIteration(`a${n}`, RUN_A._id, {
    iterationNumber: n,
    result,
    status,
    createdAt: start + n,
    updatedAt: start + seconds * 1000,
  });
const haiku = (n: number) =>
  fixtureIteration(`b${n}`, RUN_B._id, {
    iterationNumber: n,
    createdAt: start + n,
    updatedAt: start + 9_000,
    testCaseSnapshot: {
      title: CASE_TITLE,
      model: "anthropic/claude-haiku-4.5",
      provider: "anthropic",
      query: "Sketch a tiny flow",
      expectedToolCalls: [],
    },
  });

export const ITERATIONS: EvalIteration[] = [
  mini(1, "failed", 12),
  mini(2, "failed", 13),
  mini(3, "timed_out", 30, "timed_out"),
  mini(4, "passed", 17),
  haiku(1),
  haiku(2),
  haiku(3),
  haiku(4),
];

export const MATRIX = buildRunResultsMatrix({
  run: RUN_A,
  runs: [RUN_A, RUN_B],
  iterations: ITERATIONS,
  hostNamesById: new Map(),
});

const byStage = <T>(value: T) =>
  Object.fromEntries(
    USER_VALUE_STAGES.map((stage) => [stage, value]),
  ) as Record<UserValueStage, T>;

/** A case row as buildEvaluateCaseRows returns it, with what a test sets. */
export function caseRow(
  overrides: Partial<EvaluateCaseRow> = {},
): EvaluateCaseRow {
  return {
    key: CASE_ID,
    title: CASE_TITLE,
    testCaseId: CASE_ID,
    caseKey: null,
    iterations: { passed: 0, total: 0 },
    verdict: { kind: "notLoaded" },
    mark: null,
    break: { kind: "none" },
    cells: [],
    coverage: {
      total: 0,
      loaded: 0,
      breaksByStage: byStage(0),
      stageStates: byStage<
        EvaluateCaseRow["coverage"]["stageStates"][UserValueStage]
      >({ kind: "notLoaded" }),
      withheld: 0,
      note: null,
    },
    p50Ms: null,
    costUsd: null,
    costedIterations: 0,
    hasRunnerReportedCost: false,
    opensIterationId: null,
    diagnostic: null,
    failureGroups: [],
    ...overrides,
  };
}

export const FINDINGS = buildTestRunFindings(
  [
    caseRow({
      failureGroups: [
        {
          key: "selection::missingToolCall",
          stage: "selection",
          reason: "missingToolCall",
          iterationIds: ["a1", "a2", "a3"],
          representative: null,
        },
      ],
    }),
  ],
  ITERATIONS.length,
);

const row = (
  label: string,
  passed: number,
  extra: Partial<TestRunScorecard["stages"][number]["rows"][number]> = {},
) => ({
  key: label,
  label,
  role: "required" as const,
  builtin: false,
  passed,
  failed: 8 - 1 - passed,
  firstFailedIterationId: passed < 7 ? "a1" : null,
  ...extra,
});

export const SCORECARD: TestRunScorecard = {
  total: 8,
  timedOut: 1,
  stages: [
    {
      stage: "connection",
      label: "Connection",
      rows: [row("Successful connection", 7, { builtin: true })],
    },
    {
      stage: "discovery",
      label: "Discovery",
      rows: [row("Tools listed", 7, { builtin: true })],
    },
    {
      stage: "selection",
      label: "Selection",
      rows: [row("Reach read_me, create_view", 5)],
    },
    {
      stage: "call",
      label: "Tool call",
      rows: [
        row("Tool call completed", 7, { builtin: true }),
        row("Arguments match", 7),
      ],
    },
    {
      stage: "response",
      label: "Response",
      rows: [
        row("Result returned to the model", 7, { builtin: true }),
        row("Tool errors (isError)", 7),
      ],
    },
    {
      stage: "userValue",
      label: "User value",
      rows: [
        row("Catch an empty answer", 7),
        row("Track increases in token usage", 7, { role: "advisory" }),
        row("Outcome achieved", 7, { role: "advisory" }),
      ],
    },
  ],
};

const steps: TestStep[] = [
  {
    id: "p0",
    kind: "prompt",
    prompt:
      'Sketch a tiny flow: a box labeled "Start" with an arrow pointing to a box labeled "End".',
  },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "read_me",
      args: { args: {} },
    },
  },
  {
    id: "a2",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "create_view",
      args: { args: {} },
    },
  },
];

const SUITE_DEFAULTS: Predicate[] = [
  { type: "noToolErrors" },
  { type: "finalAssistantMessageNonEmpty" },
  { type: "tokenBudgetUnder", tokens: 250000 },
];

export const SUITE = {
  _id: "suite-excalidraw",
  name: "Excalidraw quickstart",
  defaultPredicates: SUITE_DEFAULTS,
  judgeConfig: { goalCompletion: { autoRun: true } },
} as EvalSuite;

export const TEST_CASE = {
  _id: CASE_ID,
  testSuiteId: SUITE._id,
  title: CASE_TITLE,
  steps,
  expectedOutput:
    "Composition: multiple elements (two boxes + arrow) in a single create_view call.",
} as EvalCase;
