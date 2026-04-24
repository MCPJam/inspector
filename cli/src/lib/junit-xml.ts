import {
  renderConformanceReportJUnitXml,
  toConformanceReport,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "@mcpjam/sdk";

export function suiteResultToJUnitXml(
  result: OAuthConformanceSuiteResult,
): string {
  return renderConformanceReportJUnitXml(toConformanceReport(result));
}

/**
 * Wraps a single ConformanceResult into the suite result shape
 * so the JUnit formatter can handle single-flow runs too.
 */
export function singleResultToJUnitXml(
  result: ConformanceResult,
  label?: string,
): string {
  if (!label) {
    return renderConformanceReportJUnitXml(toConformanceReport(result));
  }

  return renderConformanceReportJUnitXml(
    toConformanceReport({
      name: "OAuth Conformance",
      serverUrl: result.serverUrl,
      passed: result.passed,
      results: [
        {
          ...result,
          label,
        },
      ],
      summary: result.summary,
      durationMs: result.durationMs,
    }),
  );
}
