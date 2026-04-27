import {
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "@mcpjam/sdk";
import { usageError, type OutputFormat } from "./output.js";

export type OAuthOutputFormat = OutputFormat;

export function parseOAuthOutputFormat(value: string): OAuthOutputFormat {
  if (value === "json" || value === "human") {
    return value;
  }

  if (value === "junit-xml") {
    throw usageError(
      'Invalid output format "junit-xml". Use --reporter junit-xml for CI reporter output.',
    );
  }

  throw usageError(
    `Invalid output format "${value}". Use "json" or "human".`,
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
    case "json":
      return JSON.stringify(result);
  }
}
