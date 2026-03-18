import { PromptResult } from "../src/PromptResult";
import type { IterationResult, EvalRunResult } from "../src/EvalTest";
import {
  iterationToEvalResult,
  runToEvalResults,
  suiteRunToEvalResults,
  iterationsToEvalResultInputs,
  suiteTestResultsToEvalResultInputs,
} from "../src/eval-result-mapping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrompt(overrides: {
  prompt?: string;
  text?: string;
  toolCalls?: { toolName: string; arguments: Record<string, unknown> }[];
  messages?: { role: string; content: unknown }[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  latency?: { e2eMs: number; llmMs: number; mcpMs: number };
  provider?: string;
  model?: string;
  error?: string;
}): PromptResult {
  if (overrides.error) {
    return PromptResult.error(
      overrides.error,
      overrides.latency ?? 0,
      overrides.prompt ?? "",
      {
        provider: overrides.provider,
        model: overrides.model,
      }
    );
  }
  return PromptResult.from({
    prompt: overrides.prompt ?? "test prompt",
    messages: (overrides.messages as any) ?? [
      { role: "user", content: overrides.prompt ?? "test prompt" },
    ],
    text: overrides.text ?? "response",
    toolCalls: overrides.toolCalls ?? [],
    usage: overrides.usage ?? {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    latency: overrides.latency ?? { e2eMs: 100, llmMs: 80, mcpMs: 20 },
    provider: overrides.provider,
    model: overrides.model,
  });
}

function makeIteration(
  overrides: Partial<IterationResult> = {}
): IterationResult {
  return {
    passed: true,
    latencies: [{ e2eMs: 100, llmMs: 80, mcpMs: 20 }],
    tokens: { total: 15, input: 10, output: 5 },
    ...overrides,
  };
}

function makeRunResult(iterations: IterationResult[]): EvalRunResult {
  return {
    iterations: iterations.length,
    successes: iterations.filter((i) => i.passed).length,
    failures: iterations.filter((i) => !i.passed).length,
    results: iterations.map((i) => i.passed),
    iterationDetails: iterations,
    tokenUsage: {
      total: iterations.reduce((s, i) => s + i.tokens.total, 0),
      input: iterations.reduce((s, i) => s + i.tokens.input, 0),
      output: iterations.reduce((s, i) => s + i.tokens.output, 0),
      perIteration: iterations.map((i) => i.tokens),
    },
    latency: {
      e2e: { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 },
      llm: { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 },
      mcp: { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 },
      perIteration: iterations.flatMap((i) => i.latencies),
    },
  };
}

// ---------------------------------------------------------------------------
// iterationToEvalResult
// ---------------------------------------------------------------------------

describe("iterationToEvalResult", () => {
  it("converts a single-prompt iteration", () => {
    const prompt = makePrompt({
      prompt: "hello",
      toolCalls: [{ toolName: "tool_a", arguments: { x: 1 } }],
      provider: "openai",
      model: "gpt-4o",
    });
    const iteration = makeIteration({ prompts: [prompt] });

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "case-1" });

    expect(result.caseTitle).toBe("case-1");
    expect(result.passed).toBe(true);
    expect(result.query).toBe("hello");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.actualToolCalls).toEqual([
      { toolName: "tool_a", arguments: { x: 1 } },
    ]);
    expect(result.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(result.durationMs).toBe(100);
    expect(result.metadata).toEqual({ iterationNumber: 1, retryCount: 0 });
  });

  it("aggregates tool calls from all prompts in multi-turn", () => {
    const p1 = makePrompt({
      prompt: "turn 1",
      toolCalls: [{ toolName: "tool_a", arguments: {} }],
    });
    const p2 = makePrompt({
      prompt: "turn 2",
      toolCalls: [
        { toolName: "tool_b", arguments: { y: 2 } },
        { toolName: "tool_c", arguments: {} },
      ],
    });
    const iteration = makeIteration({
      prompts: [p1, p2],
      latencies: [
        { e2eMs: 100, llmMs: 80, mcpMs: 20 },
        { e2eMs: 200, llmMs: 150, mcpMs: 50 },
      ],
      tokens: { total: 30, input: 20, output: 10 },
    });

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "multi" });

    expect(result.actualToolCalls).toEqual([
      { toolName: "tool_a", arguments: {} },
      { toolName: "tool_b", arguments: { y: 2 } },
      { toolName: "tool_c", arguments: {} },
    ]);
    // Tokens come from iteration-level (pre-aggregated)
    expect(result.tokens).toEqual({ input: 20, output: 10, total: 30 });
    // Duration is sum of latencies
    expect(result.durationMs).toBe(300);
  });

  it("aggregates trace messages from all prompts", () => {
    const p1 = makePrompt({
      prompt: "turn 1",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "reply 1" },
      ],
    });
    const p2 = makePrompt({
      prompt: "turn 2",
      messages: [
        { role: "user", content: "turn 2" },
        { role: "assistant", content: "reply 2" },
      ],
    });
    const iteration = makeIteration({ prompts: [p1, p2] });

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "trace" });

    expect(result.trace).toBeDefined();
    const messages = (result.trace as any).messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "turn 1" });
    expect(messages[3]).toEqual({ role: "assistant", content: "reply 2" });
  });

  it("uses promptSelector to pick query/provider/model from selected prompt", () => {
    const p1 = makePrompt({
      prompt: "first",
      provider: "openai",
      model: "gpt-4o",
    });
    const p2 = makePrompt({
      prompt: "last",
      provider: "anthropic",
      model: "claude",
    });
    const iteration = makeIteration({ prompts: [p1, p2] });

    const resultFirst = iterationToEvalResult(iteration, 0, {
      caseTitle: "sel",
      promptSelector: "first",
    });
    expect(resultFirst.query).toBe("first");
    expect(resultFirst.provider).toBe("openai");

    const resultLast = iterationToEvalResult(iteration, 0, {
      caseTitle: "sel",
      promptSelector: "last",
    });
    expect(resultLast.query).toBe("last");
    expect(resultLast.provider).toBe("anthropic");
  });

  it("options override provider and model from prompt", () => {
    const prompt = makePrompt({ provider: "openai", model: "gpt-4o" });
    const iteration = makeIteration({ prompts: [prompt] });

    const result = iterationToEvalResult(iteration, 0, {
      caseTitle: "override",
      provider: "custom-provider",
      model: "custom-model",
    });

    expect(result.provider).toBe("custom-provider");
    expect(result.model).toBe("custom-model");
  });

  it("passes expectedToolCalls through", () => {
    const iteration = makeIteration({
      prompts: [makePrompt({})],
    });
    const expected = [{ toolName: "expected_tool", arguments: { a: 1 } }];

    const result = iterationToEvalResult(iteration, 0, {
      caseTitle: "etc",
      expectedToolCalls: expected,
    });

    expect(result.expectedToolCalls).toEqual(expected);
  });

  it("handles no-prompt fallback with empty arrays", () => {
    const iteration = makeIteration({ prompts: [] });

    const result = iterationToEvalResult(iteration, 2, { caseTitle: "empty" });

    expect(result.caseTitle).toBe("empty");
    expect(result.passed).toBe(true);
    expect(result.query).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.actualToolCalls).toEqual([]);
    expect(result.trace).toBeUndefined();
    expect(result.metadata).toEqual({ iterationNumber: 3, retryCount: 0 });
  });

  it("handles undefined prompts the same as empty", () => {
    const iteration = makeIteration();
    // prompts is undefined by default

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "undef" });

    expect(result.actualToolCalls).toEqual([]);
    expect(result.trace).toBeUndefined();
  });

  it("propagates error from iteration", () => {
    const iteration = makeIteration({
      passed: false,
      error: "LLM timeout",
      prompts: [makePrompt({})],
    });

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "err" });

    expect(result.passed).toBe(false);
    expect(result.error).toBe("LLM timeout");
  });

  it("sets retryCount from iteration", () => {
    const iteration = makeIteration({
      retryCount: 3,
      prompts: [makePrompt({})],
    });

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "retry" });

    expect(result.metadata?.retryCount).toBe(3);
  });

  it("omits durationMs when latencies sum to zero", () => {
    const iteration = makeIteration({
      latencies: [{ e2eMs: 0, llmMs: 0, mcpMs: 0 }],
      prompts: [makePrompt({})],
    });

    const result = iterationToEvalResult(iteration, 0, { caseTitle: "zero" });

    expect(result.durationMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runToEvalResults
// ---------------------------------------------------------------------------

describe("runToEvalResults", () => {
  it("maps N iterations with correct case titles", () => {
    const run = makeRunResult([
      makeIteration({ prompts: [makePrompt({ prompt: "q1" })] }),
      makeIteration({ prompts: [makePrompt({ prompt: "q2" })] }),
      makeIteration({ prompts: [makePrompt({ prompt: "q3" })] }),
    ]);

    const results = runToEvalResults(run, { casePrefix: "test" });

    expect(results).toHaveLength(3);
    expect(results[0].caseTitle).toBe("test-iter-1");
    expect(results[1].caseTitle).toBe("test-iter-2");
    expect(results[2].caseTitle).toBe("test-iter-3");
  });

  it("passes options through to iterationToEvalResult", () => {
    const run = makeRunResult([
      makeIteration({ prompts: [makePrompt({ provider: "openai" })] }),
    ]);

    const results = runToEvalResults(run, {
      casePrefix: "pfx",
      provider: "custom",
      model: "m1",
      expectedToolCalls: [{ toolName: "t" }],
      promptSelector: "last",
    });

    expect(results[0].provider).toBe("custom");
    expect(results[0].model).toBe("m1");
    expect(results[0].expectedToolCalls).toEqual([{ toolName: "t" }]);
  });
});

// ---------------------------------------------------------------------------
// suiteRunToEvalResults
// ---------------------------------------------------------------------------

describe("suiteRunToEvalResults", () => {
  it("maps multiple tests with correct case titles", () => {
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "login",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );
    testResults.set(
      "logout",
      makeRunResult([
        makeIteration({ prompts: [makePrompt({})] }),
        makeIteration({ prompts: [makePrompt({})] }),
      ])
    );

    const results = suiteRunToEvalResults(testResults, { casePrefix: "suite" });

    expect(results).toHaveLength(3);
    expect(results[0].caseTitle).toBe("suite-login-iter-1");
    expect(results[1].caseTitle).toBe("suite-logout-iter-1");
    expect(results[2].caseTitle).toBe("suite-logout-iter-2");
  });

  it("routes expectedToolCallsByTest correctly", () => {
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "test-a",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );
    testResults.set(
      "test-b",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );

    const expectedByTest = {
      "test-a": [{ toolName: "tool_x" }],
      "test-b": [{ toolName: "tool_y", arguments: { z: 1 } }],
    };

    const results = suiteRunToEvalResults(testResults, {
      casePrefix: "s",
      expectedToolCallsByTest: expectedByTest,
    });

    const testA = results.find((r) => r.caseTitle.includes("test-a"));
    const testB = results.find((r) => r.caseTitle.includes("test-b"));

    expect(testA?.expectedToolCalls).toEqual([{ toolName: "tool_x" }]);
    expect(testB?.expectedToolCalls).toEqual([
      { toolName: "tool_y", arguments: { z: 1 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// iterationsToEvalResultInputs
// ---------------------------------------------------------------------------

describe("iterationsToEvalResultInputs", () => {
  it("aggregates tool calls and trace from all prompts", () => {
    const p1 = makePrompt({
      prompt: "turn 1",
      toolCalls: [{ toolName: "a", arguments: {} }],
      messages: [{ role: "user", content: "turn 1" }],
    });
    const p2 = makePrompt({
      prompt: "turn 2",
      toolCalls: [{ toolName: "b", arguments: { x: 1 } }],
      messages: [{ role: "user", content: "turn 2" }],
    });
    const iteration = makeIteration({
      prompts: [p1, p2],
      tokens: { total: 30, input: 20, output: 10 },
    });

    const results = iterationsToEvalResultInputs("my-test", [iteration]);

    expect(results).toHaveLength(1);
    expect(results[0].actualToolCalls).toEqual([
      { toolName: "a", arguments: {} },
      { toolName: "b", arguments: { x: 1 } },
    ]);
    expect(results[0].trace).toBeDefined();
    const messages = (results[0].trace as any).messages;
    expect(messages).toHaveLength(2);
  });

  it("uses query from first prompt", () => {
    const p1 = makePrompt({ prompt: "first query" });
    const p2 = makePrompt({ prompt: "second query" });
    const iteration = makeIteration({ prompts: [p1, p2] });

    const results = iterationsToEvalResultInputs("test", [iteration]);

    expect(results[0].query).toBe("first query");
  });

  it("falls back to testName when no prompts", () => {
    const iteration = makeIteration({ prompts: [] });

    const results = iterationsToEvalResultInputs("fallback-name", [iteration]);

    expect(results[0].query).toBe("fallback-name");
    expect(results[0].caseTitle).toBe("fallback-name");
  });

  it("includes metadata with iterationNumber and retryCount", () => {
    const iterations = [
      makeIteration({ prompts: [makePrompt({})] }),
      makeIteration({ prompts: [makePrompt({})], retryCount: 2 }),
    ];

    const results = iterationsToEvalResultInputs("t", iterations);

    expect(results[0].metadata).toEqual({ retryCount: 0, iterationNumber: 1 });
    expect(results[1].metadata).toEqual({ retryCount: 2, iterationNumber: 2 });
  });

  it("propagates error", () => {
    const iteration = makeIteration({
      passed: false,
      error: "timeout",
      prompts: [],
    });

    const results = iterationsToEvalResultInputs("t", [iteration]);

    expect(results[0].error).toBe("timeout");
    expect(results[0].passed).toBe(false);
  });

  it("forwards expectedToolCalls when provided", () => {
    const iteration = makeIteration({ prompts: [makePrompt({})] });
    const expected = [
      { toolName: "tool_a", arguments: { x: 1 } },
      { toolName: "tool_b" },
    ];

    const results = iterationsToEvalResultInputs("t", [iteration], expected);

    expect(results[0].expectedToolCalls).toEqual(expected);
  });

  it("leaves expectedToolCalls undefined when omitted", () => {
    const iteration = makeIteration({ prompts: [makePrompt({})] });

    const results = iterationsToEvalResultInputs("t", [iteration]);

    expect(results[0].expectedToolCalls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// suiteTestResultsToEvalResultInputs
// ---------------------------------------------------------------------------

describe("suiteTestResultsToEvalResultInputs", () => {
  it("includes testName in metadata", () => {
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "auth-test",
      makeRunResult([
        makeIteration({ prompts: [makePrompt({ prompt: "login" })] }),
      ])
    );

    const results = suiteTestResultsToEvalResultInputs(testResults);

    expect(results).toHaveLength(1);
    expect(results[0].caseTitle).toBe("auth-test");
    expect(results[0].metadata?.testName).toBe("auth-test");
    expect(results[0].query).toBe("login");
  });

  it("maps multiple tests with multiple iterations", () => {
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "test-1",
      makeRunResult([
        makeIteration({ prompts: [makePrompt({})] }),
        makeIteration({ prompts: [makePrompt({})] }),
      ])
    );
    testResults.set(
      "test-2",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );

    const results = suiteTestResultsToEvalResultInputs(testResults);

    expect(results).toHaveLength(3);
    expect(results[0].caseTitle).toBe("test-1");
    expect(results[0].metadata?.iterationNumber).toBe(1);
    expect(results[1].caseTitle).toBe("test-1");
    expect(results[1].metadata?.iterationNumber).toBe(2);
    expect(results[2].caseTitle).toBe("test-2");
    expect(results[2].metadata?.testName).toBe("test-2");
  });

  it("aggregates tool calls from all prompts in each iteration", () => {
    const p1 = makePrompt({ toolCalls: [{ toolName: "a", arguments: {} }] });
    const p2 = makePrompt({ toolCalls: [{ toolName: "b", arguments: {} }] });
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "multi",
      makeRunResult([makeIteration({ prompts: [p1, p2] })])
    );

    const results = suiteTestResultsToEvalResultInputs(testResults);

    expect(results[0].actualToolCalls).toEqual([
      { toolName: "a", arguments: {} },
      { toolName: "b", arguments: {} },
    ]);
  });

  it("forwards per-test expectedToolCalls when provided", () => {
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "test-a",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );
    testResults.set(
      "test-b",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );

    const expectedByTest = {
      "test-a": [{ toolName: "tool_x", arguments: { k: 1 } }],
      "test-b": [{ toolName: "tool_y" }],
    };

    const results = suiteTestResultsToEvalResultInputs(
      testResults,
      expectedByTest
    );

    expect(results[0].expectedToolCalls).toEqual([
      { toolName: "tool_x", arguments: { k: 1 } },
    ]);
    expect(results[1].expectedToolCalls).toEqual([{ toolName: "tool_y" }]);
  });

  it("leaves expectedToolCalls undefined for tests without them", () => {
    const testResults = new Map<string, EvalRunResult>();
    testResults.set(
      "test-with",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );
    testResults.set(
      "test-without",
      makeRunResult([makeIteration({ prompts: [makePrompt({})] })])
    );

    const expectedByTest = {
      "test-with": [{ toolName: "tool_z" }],
    };

    const results = suiteTestResultsToEvalResultInputs(
      testResults,
      expectedByTest
    );

    const withResult = results.find((r) => r.caseTitle === "test-with");
    const withoutResult = results.find((r) => r.caseTitle === "test-without");

    expect(withResult?.expectedToolCalls).toEqual([{ toolName: "tool_z" }]);
    expect(withoutResult?.expectedToolCalls).toBeUndefined();
  });
});
