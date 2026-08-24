/**
 * Public projection of an iteration's stage evidence.
 *
 * This is intentionally separate from `evals.ts` so its TEST exercises the
 * real metadata boundary. `metadata` is an open record carrying internal
 * signals and quarantined raw payloads; only this explicit whitelist may cross
 * into a public DTO.
 */

import { stageDerivationSchema } from "@mcpjam/sdk/contract";

/**
 * Project the verified stage derivation, or its quarantine marker.
 *
 * The whole derivation is validated together because `firstFailedStage` and
 * `failureCategory` are claims about the rows: if the rows do not validate,
 * neither claim can be checked against them. In that case the public contract
 * exposes only `stageResultsUnverified` and an independently valid version,
 * never the chain or either unverified claim.
 *
 * Fields are omitted rather than nulled, so iterations predating D1 remain
 * byte-identical to their former DTOs.
 */
export function toStageProjection(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const record = metadata as Record<string, unknown>;
  if (!("stageResults" in record)) return {};

  const derivation = stageDerivationSchema.safeParse({
    stageResults: record.stageResults,
    ...(record.firstFailedStage !== undefined
      ? { firstFailedStage: record.firstFailedStage }
      : {}),
    ...(record.failureCategory !== undefined
      ? { failureCategory: record.failureCategory }
      : {}),
    stageAnalyzerVersion: record.stageAnalyzerVersion,
  });
  if (derivation.success) {
    return {
      stageResults: derivation.data.stageResults,
      ...(derivation.data.firstFailedStage
        ? { firstFailedStage: derivation.data.firstFailedStage }
        : {}),
      ...(derivation.data.failureCategory
        ? { failureCategory: derivation.data.failureCategory }
        : {}),
      stageAnalyzerVersion: derivation.data.stageAnalyzerVersion,
    };
  }

  const version = record.stageAnalyzerVersion;
  return {
    stageResultsUnverified: true,
    ...(typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 0
      ? { stageAnalyzerVersion: version }
      : {}),
  };
}
