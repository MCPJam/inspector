const capture = vi.hoisted(() =>
  vi.fn(async (input: any) => ({
    receipt: {
      schemaVersion: 1,
      state: "persisted",
      acceptedIterations: input.results.length,
      acknowledgedIterations: input.results.length,
      pendingIterations: 0,
    },
  }))
);
vi.mock("../src/eval-reporting-receipt.js", async (original) => ({
  ...(await original<typeof import("../src/eval-reporting-receipt.js")>()),
  captureEvalReporting: capture,
}));
import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import type { HostRunner } from "../src/HostRunner";
import type { Evaluator } from "../src/evaluators/types";
import {
  promptsToEvalResult,
  runToEvalResults,
} from "../src/eval-result-mapping";
import { buildEvaluationConfigSnapshot } from "../src/contract/derive";
import { scoresPassed } from "../src/scorers/run";
import type {
  EvaluationConfigSnapshot,
  ScoreResult,
} from "../src/contract/types";

/**
 * The customer case: the first `search_tasks` call errors, the model retries
 * with fixed arguments, and the answer is right. `test()` only asks whether
 * `search_tasks` was called, so it passes either way.
 */
function recoveredToolErrorResult(prompt: string): PromptResult {
  return PromptResult.from({
    prompt,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: "Found 3 open tasks." },
    ],
    text: "Found 3 open tasks.",
    toolCalls: [
      { toolName: "search_tasks", arguments: { status: "opn" } },
      { toolName: "search_tasks", arguments: { status: "open" } },
    ],
    usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
    latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
    spans: [
      {
        category: "tool",
        status: "error",
        name: "search_tasks",
        startMs: 0,
        endMs: 1,
      },
      {
        category: "tool",
        status: "ok",
        name: "search_tasks",
        startMs: 2,
        endMs: 3,
      },
    ],
  } as Parameters<typeof PromptResult.from>[0]);
}

function cleanResult(prompt: string): PromptResult {
  return PromptResult.from({
    prompt,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: "Found 3 open tasks." },
    ],
    text: "Found 3 open tasks.",
    toolCalls: [{ toolName: "search_tasks", arguments: { status: "open" } }],
    usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
    latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
    spans: [
      {
        category: "tool",
        status: "ok",
        name: "search_tasks",
        startMs: 0,
        endMs: 1,
      },
    ],
  } as Parameters<typeof PromptResult.from>[0]);
}

/** Errors on every call by default; `erroredCalls` limits which calls error. */
function scriptedAgent(erroredCalls?: ReadonlySet<number>): HostRunner {
  let calls = 0;
  const create = (): HostRunner => {
    let history: PromptResult[] = [];
    return {
      run: async (message: string) => {
        calls += 1;
        const result =
          erroredCalls === undefined || erroredCalls.has(calls)
            ? recoveredToolErrorResult(message)
            : cleanResult(message);
        history.push(result);
        return result;
      },
      resetPromptHistory: () => {
        history = [];
      },
      getPromptHistory: () => [...history],
      withOptions: () => create(),
    } as unknown as HostRunner;
  };
  return create();
}

function customerCase(): EvalTest {
  return new EvalTest({
    id: "c_recovered_tool_error",
    name: "recovered tool error",
    test: async (agent) => {
      const result = await agent.run("List my open tasks");
      return result.hasToolCall("search_tasks");
    },
  });
}

describe("local verdict and uploaded verdict for a recovered tool error", () => {
  beforeEach(() => {
    capture.mockClear();
  });

  it.each([
    { label: "unset", failOnToolError: undefined },
    { label: "true", failOnToolError: true },
    { label: "false", failOnToolError: false },
  ])("agree with failOnToolError $label", async ({ failOnToolError }) => {
    const evalCase = customerCase();
    await evalCase.run(scriptedAgent(), {
      iterations: 1,
      concurrency: 1,
      mcpjam: {
        apiKey: "test-key",
        ci: {},
        ...(failOnToolError === undefined ? {} : { failOnToolError }),
      },
    });

    expect(capture).toHaveBeenCalledTimes(1);
    const uploaded = capture.mock.calls[0][0].results;
    expect(uploaded).toHaveLength(1);

    const localPassed = evalCase.accuracy() === 1;
    const uploadedPassed = uploaded[0].passed;
    expect({ localPassed, uploadedPassed }).toEqual({
      localPassed: failOnToolError === false,
      uploadedPassed: failOnToolError === false,
    });

    const row = uploaded[0].metadata.scores.find(
      (score: { scorerId: string }) =>
        score.scorerId === "platform:toolExecution"
    );
    const definition = uploaded[0].metadata.evaluationConfig.definitions.find(
      (entry: { scorerId: string }) =>
        entry.scorerId === "platform:toolExecution"
    );
    expect(row).toMatchObject({
      status: "scored",
      value: 0,
      rationale: "1 tool call failed: search_tasks",
    });
    expect(definition.role === "advisory").toBe(failOnToolError === false);
  });
});

type UploadedRow = {
  passed: boolean;
  scores: ScoreResult[];
  config: EvaluationConfigSnapshot;
};

/** Read an uploaded result's verdict and the rows it carries. */
function uploadedRow(result: {
  passed: boolean;
  metadata?: Record<string, unknown>;
}): UploadedRow {
  const scores = result.metadata?.scores;
  const config = result.metadata?.evaluationConfig;
  if (
    !Array.isArray(scores) ||
    typeof config !== "object" ||
    config === null ||
    !("definitions" in config) ||
    !Array.isArray(config.definitions) ||
    !("hash" in config) ||
    typeof config.hash !== "string"
  ) {
    throw new Error("the uploaded result carries no score rows");
  }
  return {
    passed: result.passed,
    scores,
    config: { hash: config.hash, definitions: config.definitions },
  };
}

/** The rule every upload path must keep: `passed` is read off the rows sent. */
function expectVerdictFromRows(row: UploadedRow) {
  expect(row.passed).toBe(scoresPassed(row.scores, row.config.definitions));
}

describe("every SDK upload path sends the verdict its rows give", () => {
  beforeEach(() => {
    capture.mockClear();
  });

  it.each([undefined, true, false])(
    "promptsToEvalResult with failOnToolError %s",
    (failOnToolError) => {
      const row = uploadedRow(
        promptsToEvalResult([recoveredToolErrorResult("q")], {
          caseTitle: "helper",
          passed: true,
          ...(failOnToolError === undefined ? {} : { failOnToolError }),
        })
      );
      expect(row.passed).toBe(failOnToolError === false);
      expectVerdictFromRows(row);
      expect(row.scores.map((score) => score.scorerId)).toEqual([
        "legacy:test",
        "platform:toolExecution",
        "platform:iterationError",
      ]);
    }
  );

  it.each([undefined, true, false])(
    "PromptResult.toEvalResult with failOnToolError %s",
    (failOnToolError) => {
      const row = uploadedRow(
        recoveredToolErrorResult("q").toEvalResult({
          passed: true,
          ...(failOnToolError === undefined ? {} : { failOnToolError }),
        })
      );
      expect(row.passed).toBe(failOnToolError === false);
      expectVerdictFromRows(row);
    }
  );

  it("keeps rows a caller attached and grades over all of them", () => {
    const callerConfig = buildEvaluationConfigSnapshot([
      {
        scorerId: "caller:check",
        idSource: "explicit",
        scorerVersion: "1",
        implementationHash: "caller",
        label: "caller check",
        deterministic: true,
        passThreshold: 1,
        role: "gating",
      },
    ]);
    const callerRow = {
      scorerId: "caller:check",
      definitionHash: "",
      status: "scored",
      value: 0,
    };
    const row = uploadedRow(
      promptsToEvalResult([cleanResult("q")], {
        caseTitle: "helper",
        passed: true,
        metadata: {
          scores: [callerRow],
          evaluationConfig: callerConfig,
        },
      })
    );
    expect(row.scores[0]).toBe(callerRow);
    expect(row.config.definitions.map((entry) => entry.scorerId)).toContain(
      "caller:check"
    );
    expectVerdictFromRows(row);
  });

  it("refuses rows without their definitions", () => {
    expect(() =>
      promptsToEvalResult([cleanResult("q")], {
        caseTitle: "helper",
        passed: true,
        metadata: { scores: [] },
      })
    ).toThrow(/must be passed together/);
  });

  it("runToEvalResults uploads the run's verdict and rows", async () => {
    const evalCase = customerCase();
    const run = await evalCase.run(scriptedAgent(), {
      iterations: 1,
      concurrency: 1,
      mcpjam: { enabled: false },
    });
    const [row] = runToEvalResults(run, { casePrefix: "reporter" }).map(
      uploadedRow
    );
    expect(row.passed).toBe(false);
    expect(row.passed).toBe(run.iterationDetails[0].passed);
    expectVerdictFromRows(row);
  });

  it("declares the same config on every iteration, errored or not", async () => {
    await customerCase().run(scriptedAgent(new Set([2])), {
      iterations: 3,
      concurrency: 1,
      mcpjam: { apiKey: "test-key", ci: {} },
    });
    const uploaded = capture.mock.calls[0][0].results.map(uploadedRow);
    expect(uploaded.map((row) => row.passed)).toEqual([true, false, true]);
    expect(new Set(uploaded.map((row) => row.config.hash)).size).toBe(1);
    for (const row of uploaded) expectVerdictFromRows(row);
  });

  it("records a thrown test() as a failing iterationError row", async () => {
    const evalCase = new EvalTest({
      id: "c_throws",
      name: "throws",
      test: async () => {
        throw new Error("server unreachable");
      },
    });
    await evalCase.run(scriptedAgent(), {
      iterations: 1,
      concurrency: 1,
      retries: 0,
      mcpjam: { apiKey: "test-key", ci: {} },
    });
    const [row] = capture.mock.calls[0][0].results.map(uploadedRow);
    expect(row.passed).toBe(false);
    expect(
      row.scores.find((score) => score.scorerId === "platform:iterationError")
    ).toMatchObject({ status: "scored", value: 0 });
    expectVerdictFromRows(row);
  });

  it("recomputes built-in rows instead of trusting ones carried over", () => {
    const earlier = promptsToEvalResult([cleanResult("q")], {
      caseTitle: "helper",
      passed: true,
    });
    const failing = uploadedRow(
      promptsToEvalResult([cleanResult("q")], {
        caseTitle: "helper",
        passed: false,
        metadata: earlier.metadata,
      })
    );
    expect(failing.passed).toBe(false);
    expectVerdictFromRows(failing);
    expect(failing.scores.map((score) => score.scorerId)).toEqual([
      "legacy:test",
      "platform:toolExecution",
      "platform:iterationError",
    ]);

    const toolError = uploadedRow(
      promptsToEvalResult([recoveredToolErrorResult("q")], {
        caseTitle: "helper",
        passed: true,
        metadata: earlier.metadata,
      })
    );
    expect(toolError.passed).toBe(false);
    expectVerdictFromRows(toolError);
  });

  it("refuses a carried-over built-in definition with another policy", () => {
    const advisory = promptsToEvalResult([cleanResult("q")], {
      caseTitle: "helper",
      passed: true,
      failOnToolError: false,
    });
    expect(() =>
      promptsToEvalResult([recoveredToolErrorResult("q")], {
        caseTitle: "helper",
        passed: true,
        metadata: advisory.metadata,
      })
    ).toThrow(/"platform:toolExecution" with a different policy/);
  });
});

describe("a cancel that lands after test() returned", () => {
  function cancellingEvaluator(
    controller: AbortController,
    role: "gating" | "advisory"
  ): Evaluator {
    return {
      definition: {
        scorerId: `cancel:${role}`,
        idSource: "explicit",
        scorerVersion: "1",
        implementationHash: "impl",
        deterministic: true,
        role,
        passThreshold: 1,
      },
      evaluate: () => {
        controller.abort();
        return new Promise<never>(() => {});
      },
    };
  }

  async function runCancelled(role: "gating" | "advisory") {
    const controller = new AbortController();
    const evalCase = new EvalTest({
      id: `c_cancel_${role}`,
      name: "cancelled while scoring",
      test: async (agent) => {
        await agent.run("List my open tasks");
        return true;
      },
      evaluators: {
        mode: "extend",
        list: [cancellingEvaluator(controller, role)],
      },
    });
    const run = await evalCase.run(scriptedAgent(new Set()), {
      iterations: 1,
      concurrency: 1,
      signal: controller.signal,
      mcpjam: { enabled: false },
    });
    return {
      iteration: run.iterationDetails[0],
      definitions: run.evaluationConfig?.definitions ?? [],
    };
  }

  it("keeps the rows' verdict when only an advisory check was cut short", async () => {
    const { iteration, definitions } = await runCancelled("advisory");
    expect(iteration.status).toBe("cancelled");
    expect(iteration.passed).toBe(true);
    expect(iteration.passed).toBe(
      scoresPassed(iteration.scores ?? [], definitions)
    );
  });

  it("fails through the gating row a cut-short check writes", async () => {
    const { iteration } = await runCancelled("gating");
    expect(iteration.status).toBe("cancelled");
    expect(iteration.passed).toBe(false);
    expect(
      iteration.scores?.find((score) => score.scorerId === "cancel:gating")
    ).toMatchObject({ status: "error" });
  });
});
