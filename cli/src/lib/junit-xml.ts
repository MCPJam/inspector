import {
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "@mcpjam/sdk";
import { renderConformanceResult } from "./conformance-output.js";

export function suiteResultToJUnitXml(
  result: OAuthConformanceSuiteResult,
): string {
  return renderConformanceResult(result, "junit-xml");
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
    return renderConformanceResult(result, "junit-xml");
  }

  return renderConformanceResult(
    {
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
    },
    "junit-xml",
  );
}
