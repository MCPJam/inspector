import {
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "@mcpjam/sdk";
import {
  parseConformanceOutputFormat,
  renderConformanceResult,
  resolveConformanceOutputFormat,
  type ConformanceOutputFormat,
} from "./conformance-output.js";

export type OAuthOutputFormat = ConformanceOutputFormat;

export const parseOAuthOutputFormat = parseConformanceOutputFormat;

export const resolveOAuthOutputFormat = resolveConformanceOutputFormat;

export function renderOAuthConformanceResult(
  result: ConformanceResult,
  format: OAuthOutputFormat,
): string {
  if (format === "human") {
    return formatOAuthConformanceHuman(result);
  }

  return renderConformanceResult(result, format);
}

export function renderOAuthConformanceSuiteResult(
  result: OAuthConformanceSuiteResult,
  format: OAuthOutputFormat,
): string {
  if (format === "human") {
    return formatOAuthConformanceSuiteHuman(result);
  }

  return renderConformanceResult(result, format);
}
