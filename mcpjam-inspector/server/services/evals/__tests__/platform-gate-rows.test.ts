import { describe, expect, test } from "vitest";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";
import { buildHostedScoreContract } from "../score-rows.js";

/**
 * Rows alone must give the verdict the boolean gives, check by check. That is
 * what lets the boolean be deleted once every environment grades at
 * `enforce`, and it is why the platform rows are built from the very evidence
 * `buildEvalIterationVerdict` gated on.
 */
const erroredToolTrace = {
  messages: [],
  spans: [
    {
      category: "tool" as const,
      status: "error" as const,
      name: "list_files",
      startMs: 0,
      endMs: 1,
    },
  ],
};

const base = {
  promptTurns: [{ prompt: "hi", expectedToolCalls: ["list_files"] }],
  toolsCalledByPrompt: [["list_files"]],
  isNegativeTest: false,
  matchOptions: undefined,
  turnCheckResults: [],
  effectivePredicates: undefined,
  trace: undefined,
  usage: undefined,
  renderObservations: undefined,
  iterationError: undefined,
  failOnToolError: true,
  pinnedToolErrors: [],
  scriptedCheckFailures: [],
};

type VerdictInput = Parameters<typeof buildEvalIterationVerdict>[0];

const cases: Array<{
  name: string;
  input: Partial<VerdictInput>;
  passed: boolean;
}> = [
  { name: "nothing went wrong", input: {}, passed: true },
  {
    name: "a tool call in the trace errored",
    input: { trace: erroredToolTrace },
    passed: false,
  },
  {
    name: "a tool call errored with failOnToolError off",
    input: { trace: erroredToolTrace, failOnToolError: false },
    passed: true,
  },
  {
    name: "a pinned tool call errored",
    input: {
      pinnedToolErrors: [{ toolName: "list_files", kind: "protocol-error" }],
    },
    passed: false,
  },
  {
    name: "a pinned tool call errored with failOnToolError off",
    input: {
      pinnedToolErrors: [{ toolName: "list_files", kind: "protocol-error" }],
      failOnToolError: false,
    },
    passed: true,
  },
  {
    name: "the iteration errored, even with failOnToolError off",
    input: { iterationError: "turn timed out", failOnToolError: false },
    passed: false,
  },
  {
    name: "a widget check failed",
    input: {
      scriptedCheckFailures: [
        { toolName: "show_chart", reason: "widget did not render" },
      ],
    },
    passed: false,
  },
];

describe("hosted platform rows agree with the verdict", () => {
  test.each(cases)("$name", ({ input, passed }) => {
    const verdict = buildEvalIterationVerdict({
      ...base,
      ...input,
    } as VerdictInput);
    const { scores, evaluationConfig } = buildHostedScoreContract({
      evaluation: verdict.evaluation,
      platformGates: verdict.platformGates,
    });

    expect(verdict.passed).toBe(passed);
    expect(allGatingScorersPassed(scores, evaluationConfig).passed).toBe(
      passed,
    );
  });

  test("the assertion backtest, which never ran them, declares none", () => {
    const { evaluationConfig } = buildHostedScoreContract({});
    expect(
      evaluationConfig.definitions.filter((d) =>
        d.scorerId.startsWith("platform:"),
      ),
    ).toEqual([]);
  });
});
