/**
 * The errored-run breakdown (PLB-136): each shape a real user hit, and the
 * one it must never produce — an ordinary failing test reported as an error.
 */
import { describe, expect, it } from "vitest";
import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
  type StageResultRow,
  type StageState,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

import {
  buildRunErrorBreakdown,
  classifyIterationError,
} from "../run-error-breakdown-model";
import type { EvalIteration } from "../../evals/types";

function chain(
  states: Partial<Record<UserValueStage, StageState>>,
  reasons: Partial<Record<UserValueStage, string>>,
): EvalRunDecisionChain {
  const stages = USER_VALUE_STAGES.map(
    (stage) =>
      ({
        stage,
        state: states[stage] ?? "passed",
        ...(reasons[stage] ? { reason: reasons[stage] } : {}),
      }) as StageResultRow,
  );
  const firstFailed = stages.find((row) => row.state === "failed")?.stage;
  return {
    status: "verified",
    stages,
    ...(firstFailed ? { firstFailedStage: firstFailed } : {}),
    analyzerVersion: 8,
  } as EvalRunDecisionChain;
}

const toolErrorChain = chain(
  { call: "failed", response: "notReached", userValue: "notReached" },
  { call: "toolError" },
);
const missingCallChain = chain(
  {
    selection: "failed",
    call: "notReached",
    response: "notReached",
    userValue: "notReached",
  },
  { selection: "missingToolCall" },
);
const providerErrorChain = chain(
  {
    selection: "notMeasured",
    call: "notMeasured",
    response: "notMeasured",
    userValue: "notMeasured",
  },
  { selection: "providerError" },
);

function iteration(
  id: string,
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    testCaseId: `case_${id}`,
    status: "completed",
    result: "failed",
    iterationNumber: 1,
    actualToolCalls: [],
    tokensUsed: 0,
    createdBy: "u",
    createdAt: 0,
    updatedAt: 0,
    testCaseSnapshot: {
      title: "Find a transfer",
      query: "Find my last transfer",
      provider: "anthropic",
      model: "sonnet",
      expectedToolCalls: [],
    },
    ...overrides,
  } as EvalIteration;
}

const pinnedSnapshot = {
  title: "Find credit transfers",
  query: "",
  provider: "none",
  model: "none",
  expectedToolCalls: [],
  promptTurns: [
    {
      id: "turn-1",
      prompt: "",
      expectedToolCalls: [],
      pinnedToolCall: {
        serverName: "bko",
        toolName: "find_credit_transfers",
        arguments: {},
      },
    },
  ],
} as unknown as EvalIteration["testCaseSnapshot"];

describe("classifyIterationError", () => {
  it("names the user's server when it returned a tool error", () => {
    expect(classifyIterationError(iteration("a"), toolErrorChain)).toBe(
      "serverError",
    );
  });

  it("points at the test's saved inputs when a pinned call is rejected", () => {
    expect(
      classifyIterationError(
        iteration("a", { testCaseSnapshot: pinnedSnapshot }),
        toolErrorChain,
      ),
    ).toBe("testInput");
  });

  it("does not call an ordinary failing test an error", () => {
    expect(classifyIterationError(iteration("a"), missingCallChain)).toBeNull();
  });

  it("ignores passing and unfinished results", () => {
    expect(
      classifyIterationError(iteration("a", { result: "passed" }), null),
    ).toBeNull();
    expect(
      classifyIterationError(
        iteration("a", { status: "cancelled", result: "cancelled" }),
        null,
      ),
    ).toBeNull();
  });

  it("reads a disconnected pinned server from the recorded error", () => {
    expect(
      classifyIterationError(
        iteration("a", {
          status: "setup_failed",
          error:
            'pinned_server_not_connected: "bko" is not connected in this run\'s environment',
        }),
        null,
      ),
    ).toBe("serverUnreachable");
  });

  it("puts a model-provider failure on MCPJam's side", () => {
    expect(classifyIterationError(iteration("a"), providerErrorChain)).toBe(
      "platform",
    );
  });

  it("says unknown rather than guessing when nothing settles it", () => {
    expect(
      classifyIterationError(
        iteration("a", { status: "failed", error: "something odd happened" }),
        null,
      ),
    ).toBe("unknown");
  });
});

describe("buildRunErrorBreakdown", () => {
  it("explains a run where every result hit a server tool error", () => {
    const iterations = ["a", "b", "c"].map((id) => iteration(id));
    const breakdown = buildRunErrorBreakdown({
      iterations,
      chains: new Map(iterations.map((row) => [row._id, toolErrorChain])),
    });
    expect(breakdown).not.toBeNull();
    expect(breakdown!.headline).toBe(
      "All 3 results in this run ended in an error.",
    );
    expect(breakdown!.groups).toEqual([
      expect.objectContaining({
        cause: "serverError",
        owner: "yourServer",
        count: 3,
        exampleIterationId: "a",
      }),
    ]);
  });

  it("prefers the diagnostic's chain and groups mixed causes in a fixed order", () => {
    const iterations = [
      iteration("provider"),
      iteration("server"),
      iteration("pinned", { testCaseSnapshot: pinnedSnapshot }),
    ];
    const breakdown = buildRunErrorBreakdown({
      iterations,
      diagnostics: [
        { iterationId: "provider", chain: providerErrorChain },
        { iterationId: "server", chain: toolErrorChain },
        { iterationId: "pinned", chain: toolErrorChain },
      ] as never,
    });
    expect(breakdown!.groups.map((group) => group.cause)).toEqual([
      "serverError",
      "testInput",
      "platform",
    ]);
  });

  it("stays quiet when errors are not most of the run", () => {
    const iterations = [
      iteration("err"),
      iteration("p1", { result: "passed" }),
      iteration("p2", { result: "passed" }),
    ];
    expect(
      buildRunErrorBreakdown({
        iterations,
        chains: new Map([["err", toolErrorChain]]),
      }),
    ).toBeNull();
  });

  it("stays quiet when the run failed on its merits", () => {
    const iterations = [iteration("a"), iteration("b")];
    expect(
      buildRunErrorBreakdown({
        iterations,
        chains: new Map(iterations.map((row) => [row._id, missingCallChain])),
      }),
    ).toBeNull();
  });

  it("counts against finished results only", () => {
    const breakdown = buildRunErrorBreakdown({
      iterations: [
        iteration("a"),
        iteration("b", { status: "cancelled", result: "cancelled" }),
      ],
      chains: new Map([["a", toolErrorChain]]),
    });
    expect(breakdown!.finished).toBe(1);
    expect(breakdown!.headline).toBe(
      "The only result in this run ended in an error.",
    );
  });
});
