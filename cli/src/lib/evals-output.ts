import type { EvalSuiteResult, EvalRunResult } from "@mcpjam/sdk";
import type { EvalsConfig } from "./evals-config";

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatEvalsHuman(
  result: EvalSuiteResult,
  config: EvalsConfig,
): string {
  const suiteName = config.mcpjam?.suiteName ?? "Eval Suite";
  const iterations =
    config.options?.iterations ?? 5;
  const concurrency = config.options?.concurrency ?? 3;

  const lines: string[] = [];
  lines.push(`Eval Suite: ${suiteName}`);
  lines.push(`Model: ${config.agent.model}`);
  lines.push(
    `Iterations: ${iterations} per test, concurrency ${concurrency}`,
  );
  lines.push("");

  // Header
  const cols = {
    test: 20,
    pass: 14,
    p50: 14,
    p95: 14,
    tokens: 10,
  };

  lines.push(
    `  ${padRight("Test", cols.test)}${padRight("Pass Rate", cols.pass)}${padRight("p50 Latency", cols.p50)}${padRight("p95 Latency", cols.p95)}${"Tokens"}`,
  );

  // Rows
  for (const [name, testResult] of result.tests) {
    const passRate = `${testResult.successes}/${testResult.iterations} (${Math.round((testResult.successes / testResult.iterations) * 100)}%)`;
    const p50 = formatSeconds(testResult.latency.e2e.p50);
    const p95 = formatSeconds(testResult.latency.e2e.p95);
    const tokens = `~${testResult.tokenUsage.total}`;

    lines.push(
      `  ${padRight(name, cols.test)}${padRight(passRate, cols.pass)}${padRight(p50, cols.p50)}${padRight(p95, cols.p95)}${tokens}`,
    );
  }

  lines.push("");

  const pct = Math.round(result.aggregate.accuracy * 100);
  lines.push(
    `Aggregate: ${pct}% accuracy, ${result.aggregate.successes}/${result.aggregate.iterations} passed`,
  );

  return lines.join("\n") + "\n";
}

// --- JUnit XML ---

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function testResultToTestSuite(
  name: string,
  testResult: EvalRunResult,
  suiteName: string,
): string {
  const tests = testResult.iterations;
  const failures = testResult.failures;
  const classname = escapeXml(suiteName);
  const escapedName = escapeXml(name);

  const cases = testResult.iterationDetails
    .map((iter, i) => {
      const caseName = escapeXml(`${name} [iteration ${i + 1}]`);
      if (iter.passed) {
        return `    <testcase name="${caseName}" classname="${classname}"/>`;
      }
      const message = escapeXml(iter.error ?? "Test assertion failed");
      return `    <testcase name="${caseName}" classname="${classname}">\n      <failure message="${message}"/>\n    </testcase>`;
    })
    .join("\n");

  return `  <testsuite name="${escapedName}" tests="${tests}" failures="${failures}">\n${cases}\n  </testsuite>`;
}

export function formatEvalsJUnit(
  result: EvalSuiteResult,
  suiteName: string,
): string {
  const totalTests = result.aggregate.iterations;
  const totalFailures = result.aggregate.failures;
  const escapedSuiteName = escapeXml(suiteName);

  const suites: string[] = [];
  for (const [name, testResult] of result.tests) {
    suites.push(testResultToTestSuite(name, testResult, suiteName));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${escapedSuiteName}" tests="${totalTests}" failures="${totalFailures}">\n${suites.join("\n")}\n</testsuites>\n`;
}
