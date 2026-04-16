import assert from "node:assert/strict";
import test from "node:test";
import { formatEvalsHuman, formatEvalsJUnit } from "../src/lib/evals-output";
import type { EvalSuiteResult, EvalRunResult } from "@mcpjam/sdk";
import type { EvalsConfig } from "../src/lib/evals-config";

function makeTestResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    iterations: 5,
    successes: 4,
    failures: 1,
    results: [true, true, true, true, false],
    iterationDetails: [
      { passed: true, latencies: [{ e2eMs: 1000, llmMs: 800, mcpMs: 200 }], tokens: { total: 100, input: 60, output: 40 } },
      { passed: true, latencies: [{ e2eMs: 1100, llmMs: 900, mcpMs: 200 }], tokens: { total: 110, input: 65, output: 45 } },
      { passed: true, latencies: [{ e2eMs: 1200, llmMs: 950, mcpMs: 250 }], tokens: { total: 120, input: 70, output: 50 } },
      { passed: true, latencies: [{ e2eMs: 1300, llmMs: 1000, mcpMs: 300 }], tokens: { total: 130, input: 75, output: 55 } },
      { passed: false, latencies: [{ e2eMs: 2000, llmMs: 1500, mcpMs: 500 }], tokens: { total: 200, input: 120, output: 80 }, error: "Tool mismatch" },
    ],
    tokenUsage: {
      total: 660,
      input: 390,
      output: 270,
      perIteration: [
        { total: 100, input: 60, output: 40 },
        { total: 110, input: 65, output: 45 },
        { total: 120, input: 70, output: 50 },
        { total: 130, input: 75, output: 55 },
        { total: 200, input: 120, output: 80 },
      ],
    },
    latency: {
      e2e: { min: 1000, max: 2000, mean: 1320, p50: 1200, p95: 2000, count: 5 },
      llm: { min: 800, max: 1500, mean: 1030, p50: 950, p95: 1500, count: 5 },
      mcp: { min: 200, max: 500, mean: 290, p50: 250, p95: 500, count: 5 },
      perIteration: [
        { e2eMs: 1000, llmMs: 800, mcpMs: 200 },
        { e2eMs: 1100, llmMs: 900, mcpMs: 200 },
        { e2eMs: 1200, llmMs: 950, mcpMs: 250 },
        { e2eMs: 1300, llmMs: 1000, mcpMs: 300 },
        { e2eMs: 2000, llmMs: 1500, mcpMs: 500 },
      ],
    },
    ...overrides,
  };
}

function makeSuiteResult(): EvalSuiteResult {
  const tests = new Map<string, EvalRunResult>();
  tests.set("addition", makeTestResult());
  tests.set("echo", makeTestResult({ successes: 5, failures: 0 }));

  return {
    tests,
    aggregate: {
      iterations: 10,
      successes: 9,
      failures: 1,
      accuracy: 0.9,
      tokenUsage: { total: 1320, perTest: [660, 660] },
      latency: {
        e2e: { min: 1000, max: 2000, mean: 1320, p50: 1200, p95: 2000, count: 10 },
        llm: { min: 800, max: 1500, mean: 1030, p50: 950, p95: 1500, count: 10 },
        mcp: { min: 200, max: 500, mean: 290, p50: 250, p95: 500, count: 10 },
      },
    },
  };
}

function makeConfig(): EvalsConfig {
  return {
    servers: { everything: { command: "npx", args: [] } },
    agent: { model: "openai/gpt-4o", apiKey: "test" },
    tests: [
      { name: "addition", prompt: "Add 2+3", expectedToolCalls: ["add"] },
      { name: "echo", prompt: "Echo hello", expectedToolCalls: ["echo"] },
    ],
    options: { iterations: 5, concurrency: 3 },
    mcpjam: { suiteName: "Math Eval" },
  };
}

// --- Human format tests ---

test("formatEvalsHuman includes suite name and model", () => {
  const output = formatEvalsHuman(makeSuiteResult(), makeConfig());
  assert.ok(output.includes("Math Eval"), "should contain suite name");
  assert.ok(output.includes("openai/gpt-4o"), "should contain model");
});

test("formatEvalsHuman includes test names and pass rates", () => {
  const output = formatEvalsHuman(makeSuiteResult(), makeConfig());
  assert.ok(output.includes("addition"), "should contain test name");
  assert.ok(output.includes("echo"), "should contain test name");
  assert.ok(output.includes("4/5"), "should contain pass rate for addition");
  assert.ok(output.includes("80%"), "should contain percentage");
});

test("formatEvalsHuman includes aggregate line", () => {
  const output = formatEvalsHuman(makeSuiteResult(), makeConfig());
  assert.ok(output.includes("90%"), "should contain aggregate accuracy");
  assert.ok(output.includes("9/10"), "should contain aggregate pass count");
});

test("formatEvalsHuman shows failure details with error messages", () => {
  const output = formatEvalsHuman(makeSuiteResult(), makeConfig());
  assert.ok(output.includes("Failures:"), "should contain Failures section");
  assert.ok(output.includes("Tool mismatch"), "should contain error message from failed iteration");
});

test("formatEvalsHuman omits failure section when all tests pass", () => {
  const result = makeSuiteResult();
  // Override addition to all-pass
  result.tests.set("addition", makeTestResult({ successes: 5, failures: 0 }));
  result.aggregate.failures = 0;
  const output = formatEvalsHuman(result, makeConfig());
  assert.ok(!output.includes("Failures:"), "should not contain Failures section");
});

// --- JUnit XML format tests ---

test("formatEvalsJUnit produces valid XML structure", () => {
  const output = formatEvalsJUnit(makeSuiteResult(), "Math Eval");
  assert.ok(output.startsWith('<?xml version="1.0"'), "should start with XML declaration");
  assert.ok(output.includes("<testsuites"), "should contain testsuites element");
  assert.ok(output.includes("<testsuite"), "should contain testsuite elements");
  assert.ok(output.includes("<testcase"), "should contain testcase elements");
  assert.ok(output.includes("</testsuites>"), "should close testsuites");
});

test("formatEvalsJUnit includes failure elements for failed iterations", () => {
  const output = formatEvalsJUnit(makeSuiteResult(), "Math Eval");
  assert.ok(output.includes("<failure"), "should contain failure element");
  assert.ok(output.includes("Tool mismatch"), "should contain error message");
});

test("formatEvalsJUnit includes correct test counts", () => {
  const output = formatEvalsJUnit(makeSuiteResult(), "Math Eval");
  assert.ok(output.includes('tests="10"'), "should have total test count");
  assert.ok(output.includes('failures="1"'), "should have total failure count");
});

test("formatEvalsJUnit escapes XML special characters", () => {
  const result = makeSuiteResult();
  const output = formatEvalsJUnit(result, 'Suite <"test"> & more');
  assert.ok(
    output.includes("&lt;") && output.includes("&gt;") && output.includes("&amp;"),
    "should escape special XML chars",
  );
});
