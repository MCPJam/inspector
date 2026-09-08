import { deepJsonSafe } from "../../json-safe.js";
import type {
  MCPCheckSkipReason, MCPCheckEra, MCPCheckResult } from "../types.js";

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
      // Raw thrown values are often class instances (e.g. MCPAuthError), and
      // the persistence layer rejects those wholesale — one live instance in
      // `errorDetails` used to destroy the entire finished report at the
      // Convex write. Reports carry plain JSON data only.
      details: deepJsonSafe(errorDetails),
    },
    details,
  };
}

function skipped(
  check: CheckMetadata,
  skipReason: MCPCheckSkipReason,
  message: string,
  details?: Record<string, unknown>,
): MCPCheckResult {
  return {
    ...check,
    status: "skipped",
    skipReason,
    durationMs: 0,
    error: {
      message,
    },
    details,
  };
}

/**
 * The requirement cannot apply to THIS server, so nothing is left unverified:
 * an era-gated check on another protocol version, a capability the server
 * never advertised, a localhost-only requirement against a remote target. A
 * run may still legitimately pass with these.
 */
export function notApplicableResult(
  check: CheckMetadata,
  message: string,
  details?: Record<string, unknown>,
): MCPCheckResult {
  return skipped(check, "not-applicable", message, details);
}

/**
 * The requirement DOES apply here, but the run could not exercise it — a
 * broken session, no suitable subject, an opt-in probe the caller did not
 * supply. The obligation is untested, so the run reports `incomplete` and can
 * never claim conformance.
 */
export function couldNotRunResult(
  check: CheckMetadata,
  message: string,
  details?: Record<string, unknown>,
): MCPCheckResult {
  return skipped(check, "could-not-run", message, details);
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
