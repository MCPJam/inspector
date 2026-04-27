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
