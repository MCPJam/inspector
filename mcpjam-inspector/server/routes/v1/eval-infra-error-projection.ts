import { parseCreditRecovery, type CreditRecovery } from "@mcpjam/sdk/contract";
import { recoveryForStopCode } from "../../../shared/credit-exhaustion.js";

/**
 * The public projection of `testIteration.infraError`: MCPJam's own
 * infrastructure (the model provider, the sandbox, the platform) failed the
 * trial, so it measured nothing about the server and every score excludes it.
 *
 * A WHITELIST like every other projection here: known keys only, each
 * type-checked, so nothing the row carries beyond the contract crosses the
 * boundary. OMITTED — never nulled — for a trial without one.
 */
export type InfraErrorDto = {
  class: string;
  layer: string;
  retryable: boolean;
  code?: string;
  httpStatus?: number;
  /** The step a credit refusal named. */
  recovery?: CreditRecovery;
};

/**
 * `metadata` is the iteration's: the runner records a credit refusal's
 * `recovery` there (`metadata.creditRecovery`), because the row's
 * `infraError` validator is closed and the metadata record is not.
 */
export function toInfraErrorProjection(
  raw: unknown,
  metadata?: unknown,
): {
  infraError?: InfraErrorDto;
} {
  if (!raw || typeof raw !== "object") return {};
  const row = raw as Record<string, unknown>;
  if (typeof row.class !== "string" || typeof row.layer !== "string") return {};
  // Only beside MCPJam's own stop code: the step is shown as MCPJam's.
  const recovery =
    row.class === "account_limit" &&
    typeof row.code === "string" &&
    metadata &&
    typeof metadata === "object"
      ? recoveryForStopCode(
          row.code,
          parseCreditRecovery(
            (metadata as Record<string, unknown>).creditRecovery,
          ),
        )
      : undefined;
  return {
    infraError: {
      class: row.class,
      layer: row.layer,
      retryable: row.retryable === true,
      ...(typeof row.code === "string" ? { code: row.code } : {}),
      ...(typeof row.httpStatus === "number"
        ? { httpStatus: row.httpStatus }
        : {}),
      ...(recovery ? { recovery } : {}),
    },
  };
}
