import type {
  ConformanceResult,
  OAuthConformanceSuiteResult,
  StepResult,
} from "@mcpjam/sdk";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stepToTestCase(step: StepResult, classname: string): string {
  const name = escapeXml(step.title || step.step);
  const time = (step.durationMs / 1000).toFixed(3);
  const cls = escapeXml(classname);

  if (step.status === "skipped") {
    return `    <testcase name="${name}" classname="${cls}" time="${time}">\n      <skipped/>\n    </testcase>`;
  }

  if (step.status === "failed") {
    const message = escapeXml(step.error?.message ?? "Unknown failure");
    const details = step.httpAttempts
      .map((attempt) => {
        const req = `${attempt.request.method} ${attempt.request.url}`;
        const res = attempt.response
          ? `${attempt.response.status} ${attempt.response.statusText}`
          : "No response";
        return `${req} → ${res}`;
      })
      .join("\n");
    const body = details ? escapeXml(details) : "";
    return `    <testcase name="${name}" classname="${cls}" time="${time}">\n      <failure message="${message}">${body}</failure>\n    </testcase>`;
  }

  return `    <testcase name="${name}" classname="${cls}" time="${time}"/>`;
}

function flowToTestSuite(
  result: ConformanceResult & { label: string },
): string {
  const name = escapeXml(result.label);
  const tests = result.steps.length;
  const failures = result.steps.filter((s) => s.status === "failed").length;
  const skipped = result.steps.filter((s) => s.status === "skipped").length;
  const time = (result.durationMs / 1000).toFixed(3);
  const classname = result.serverUrl;

  const cases = result.steps
    .map((step) => stepToTestCase(step, classname))
    .join("\n");

  return `  <testsuite name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">\n${cases}\n  </testsuite>`;
}

export function suiteResultToJUnitXml(
  result: OAuthConformanceSuiteResult,
): string {
  const name = escapeXml(result.name);
  const tests = result.results.reduce((sum, r) => sum + r.steps.length, 0);
  const failures = result.results.reduce(
    (sum, r) => sum + r.steps.filter((s) => s.status === "failed").length,
    0,
  );
  const time = (result.durationMs / 1000).toFixed(3);

  const suites = result.results.map(flowToTestSuite).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${name}" tests="${tests}" failures="${failures}" time="${time}">\n${suites}\n</testsuites>\n`;
}

/**
 * Wraps a single ConformanceResult into the suite result shape
 * so the JUnit formatter can handle single-flow runs too.
 */
export function singleResultToJUnitXml(
  result: ConformanceResult,
  label?: string,
): string {
  const suiteResult: OAuthConformanceSuiteResult = {
    name: "OAuth Conformance",
    serverUrl: result.serverUrl,
    passed: result.passed,
    results: [
      {
        ...result,
        label:
          label ??
          `${result.protocolVersion}/${result.registrationStrategy}`,
      },
    ],
    summary: result.summary,
    durationMs: result.durationMs,
  };
  return suiteResultToJUnitXml(suiteResult);
}
