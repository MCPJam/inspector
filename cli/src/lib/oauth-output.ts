import {
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  renderConformanceReportJUnitXml,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
  toConformanceReport,
} from "@mcpjam/sdk";
import { usageError, type OutputFormat } from "./output.js";

export type OAuthOutputFormat = OutputFormat | "junit-xml";

export function parseOAuthOutputFormat(value: string): OAuthOutputFormat {
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }

  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`,
  );
}

export function resolveOAuthOutputFormat(
  value: string | undefined,
  isTTY: boolean | undefined,
): OAuthOutputFormat {
  return parseOAuthOutputFormat(value ?? (isTTY ? "human" : "json"));
}

export function renderOAuthConformanceResult(
  result: ConformanceResult,
  format: OAuthOutputFormat,
): string {
  switch (format) {
    case "human":
      return formatOAuthConformanceHuman(result);
    case "junit-xml":
      return renderConformanceReportJUnitXml(toConformanceReport(result));
    case "json":
      return JSON.stringify(result);
  }
}

export function renderOAuthConformanceSuiteResult(
  result: OAuthConformanceSuiteResult,
  format: OAuthOutputFormat,
): string {
  switch (format) {
    case "human":
      return formatOAuthConformanceSuiteHuman(result);
    case "junit-xml":
      return renderConformanceReportJUnitXml(toConformanceReport(result));
    case "json":
      return JSON.stringify(result);
  }
}
