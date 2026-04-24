import {
  renderConformanceReportJUnitXml,
  toConformanceReport,
  type SupportedConformanceResult,
} from "@mcpjam/sdk";
import { usageError, type OutputFormat } from "./output.js";

export type ConformanceOutputFormat = OutputFormat | "junit-xml";

export function parseConformanceOutputFormat(
  value: string,
): ConformanceOutputFormat {
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }

  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`,
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
    case "junit-xml":
      return renderConformanceReportJUnitXml(toConformanceReport(result));
  }
}
