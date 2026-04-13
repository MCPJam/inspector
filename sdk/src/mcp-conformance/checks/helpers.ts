import type { MCPCheckResult } from "../types.js";

type CheckMetadata = Pick<
  MCPCheckResult,
  "id" | "category" | "title" | "description"
>;

export function passedResult(
  check: CheckMetadata,
  durationMs: number,
  details?: Record<string, unknown>,
): MCPCheckResult {
  return {
    ...check,
    status: "passed",
    durationMs,
    details,
  };
}

export function failedResult(
  check: CheckMetadata,
  durationMs: number,
  message: string,
  details?: Record<string, unknown>,
  errorDetails?: unknown,
): MCPCheckResult {
  return {
    ...check,
    status: "failed",
    durationMs,
    error: {
      message,
      details: errorDetails,
    },
    details,
  };
}

export function skippedResult(
  check: CheckMetadata,
  message: string,
  details?: Record<string, unknown>,
): MCPCheckResult {
  return {
    ...check,
    status: "skipped",
    durationMs: 0,
    error: {
      message,
    },
    details,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
