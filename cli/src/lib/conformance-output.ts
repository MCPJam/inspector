import {
  renderConformanceReportJson,
  renderConformanceReportJUnitXml,
  toConformanceReport,
  type SupportedConformanceResult,
} from "@mcpjam/sdk";
import {
  rejectReporterFormatAsOutputFormat,
  usageError,
  type OutputFormat,
} from "./output.js";
import type { ReporterFormat } from "./reporting.js";

export type ConformanceOutputFormat = OutputFormat;

export function parseConformanceOutputFormat(
  value: string,
): ConformanceOutputFormat {
  if (value === "json" || value === "human") {
    return value;
  }

  rejectReporterFormatAsOutputFormat(value);

  throw usageError(
    `Invalid output format "${value}". Use "json" or "human".`,
  );
}

export function resolveConformanceOutputFormat(
  value: string | undefined,
  isTTY: boolean | undefined,
): ConformanceOutputFormat {
  return parseConformanceOutputFormat(value ?? (isTTY ? "human" : "json"));
}

export function resolveConformanceOutputFormatForCli(
  value: string | undefined,
  isTTY: boolean | undefined,
  reporter: ReporterFormat | undefined,
): ConformanceOutputFormat {
  if (reporter === undefined || value === undefined) {
    return resolveConformanceOutputFormat(value, isTTY);
  }

  if (value === "json" || value === "human") {
    return value;
  }

  if (value === "junit-xml" || value === "json-summary") {
    return "json";
  }

  throw usageError(
    `Invalid output format "${value}". Use "json" or "human".`,
  );
}

export function renderConformanceResult(
  result: SupportedConformanceResult,
  format: ConformanceOutputFormat,
): string {
  switch (format) {
    case "human":
      return JSON.stringify(result, null, 2);
    case "json":
      return JSON.stringify(result);
  }
}

export function renderConformanceReporterResult(
  result: SupportedConformanceResult,
  reporter: ReporterFormat,
): string {
  const report = toConformanceReport(result);

  switch (reporter) {
    case "json-summary":
      return JSON.stringify(renderConformanceReportJson(report));
    case "junit-xml":
      return renderConformanceReportJUnitXml(report);
  }
}

export function renderConformanceForCli(
  result: SupportedConformanceResult,
  reporter: ReporterFormat | undefined,
  format: ConformanceOutputFormat,
): string {
  return reporter
    ? renderConformanceReporterResult(result, reporter)
    : renderConformanceResult(result, format);
}
