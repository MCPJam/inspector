import {
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "@mcpjam/sdk";
import { redactCredentialsFromResult } from "./credentials-file.js";
import {
  usageError,
  type OutputFormat,
} from "./output.js";
import { redactSensitiveValue } from "./redaction.js";

export type OAuthOutputFormat = OutputFormat;

export interface OAuthConformanceRenderOptions {
  credentialsFilePath?: string;
}

export interface OAuthConformanceSuiteRenderOptions
  extends OAuthConformanceRenderOptions {
  credentialsResultIndex?: number;
}

export function parseOAuthOutputFormat(value: string): OAuthOutputFormat {
  if (value === "json" || value === "human") {
    return value;
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
  options: OAuthConformanceRenderOptions = {},
): string {
  const redactedResult = redactOAuthConformanceResult(result, options);

  switch (format) {
    case "human":
      return formatOAuthConformanceHuman(redactedResult);
    case "json":
      return JSON.stringify(redactedResult);
  }
}

export function renderOAuthConformanceSuiteResult(
  result: OAuthConformanceSuiteResult,
  format: OAuthOutputFormat,
  options: OAuthConformanceSuiteRenderOptions = {},
): string {
  const redactedResult = redactOAuthConformanceSuiteResult(result, options);

  switch (format) {
    case "human":
      return formatOAuthConformanceSuiteHuman(redactedResult);
    case "json":
      return JSON.stringify(redactedResult);
  }
}

function redactOAuthConformanceResult(
  result: ConformanceResult,
  options: OAuthConformanceRenderOptions,
): ConformanceResult & { credentialsFile?: string } {
  if (options.credentialsFilePath && result.credentials) {
    return redactCredentialsFromResult(
      result,
      options.credentialsFilePath,
    ) as ConformanceResult & { credentialsFile?: string };
  }

  return redactSensitiveValue(result) as ConformanceResult & {
    credentialsFile?: string;
  };
}

function redactOAuthConformanceSuiteResult(
  result: OAuthConformanceSuiteResult,
  options: OAuthConformanceSuiteRenderOptions,
): OAuthConformanceSuiteResult & { credentialsFile?: string } {
  const redacted = redactSensitiveValue(result) as OAuthConformanceSuiteResult & {
    credentialsFile?: string;
  };

  if (options.credentialsFilePath) {
    redacted.credentialsFile = options.credentialsFilePath;
  }

  const resultIndex = options.credentialsResultIndex;
  if (
    options.credentialsFilePath &&
    resultIndex !== undefined &&
    result.results[resultIndex]?.credentials &&
    redacted.results[resultIndex]
  ) {
    redacted.results[resultIndex] = {
      ...redacted.results[resultIndex],
      ...redactCredentialsFromResult(
        result.results[resultIndex],
        options.credentialsFilePath,
      ),
    };
  }

  return redacted;
}
