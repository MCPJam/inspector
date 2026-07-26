import type { MCPCheckEra, MCPCheckResult } from "../types.js";

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

/**
 * Canonical skip reason for a check that does not apply to the run's era.
 * Shared by the client-backed `eraGate` and the raw-HTTP runners so the
 * message is identical across both tracks.
 */
export function eraSkipMessage(
  era: MCPCheckEra,
  protocolVersion: string | undefined,
): string {
  const pin = protocolVersion ?? "default";
  return `Not applicable to the ${era} era (run pinned to ${pin})`;
}
