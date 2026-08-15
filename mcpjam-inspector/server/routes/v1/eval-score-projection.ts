/**
 * Public projection of an iteration's score evidence.
 *
 * Extracted from `evals.ts` so its TEST can exercise the real function. The
 * route module is a large Hono app with a heavy dependency graph, and a test
 * that re-implements the projection rule proves only that the test agrees with
 * itself — precisely the drift this boundary cannot afford, since what it
 * guards is `metadata` (an open record carrying internal signals and
 * quarantined raw payloads) never reaching a public caller.
 */

import {
  evaluationConfigSnapshotSchema,
  scoreResultArraySchema,
} from "@mcpjam/sdk/contract";

/** Iteration-level integrity verdicts the backend may stamp. */
export const ITERATION_SCORE_INTEGRITY = new Set(["score_integrity_invalid"]);

/** Run-level integrity verdicts the gate engine consumes. */
export const RUN_SCORE_INTEGRITY = new Set(["valid", "invalid"]);

/**
 * Project `scores` / `evaluationConfig` / `scoreIntegrity` off an iteration's
 * metadata, as EXPLICIT whitelist fields — never a passthrough.
 *
 * Three rules, each of which fails closed:
 *
 *  1. Both evidence halves ship together or neither does. Results carry only a
 *     `definitionHash`; `role` and the error policies live on the definitions,
 *     so results alone cannot tell a gating failure from an advisory one.
 *  2. Anything that fails validation projects as ABSENT, not as
 *     partially-trusted data.
 *  3. An integrity-invalid iteration projects NO evidence at all. Its
 *     surviving rows are the subset that happened to validate, so publishing
 *     them would let a consumer compute a clean pass from an incomplete
 *     picture of a verdict the backend already downgraded.
 *
 * The `scoreIntegrity` flag survives every one of those paths — an operator
 * must be able to tell "this run has no scores" from "this run's scores did
 * not verify".
 *
 * Fields are OMITTED rather than nulled, so the DTO is byte-identical for
 * every iteration predating scores.
 */
export function toScoreProjection(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const record = metadata as Record<string, unknown>;

  const integrity =
    typeof record.scoreIntegrity === "string" &&
    ITERATION_SCORE_INTEGRITY.has(record.scoreIntegrity)
      ? { scoreIntegrity: record.scoreIntegrity }
      : {};

  if ("scoreIntegrity" in integrity) return integrity;

  const scores = scoreResultArraySchema.safeParse(record.scores);
  const config = evaluationConfigSnapshotSchema.safeParse(
    record.evaluationConfig
  );
  if (!scores.success || !config.success) return {};

  return { scores: scores.data, evaluationConfig: config.data };
}

/** Project a run's integrity verdict, omitted when the backend produced none. */
export function toRunScoreIntegrity(
  scoreIntegrity: unknown
): Record<string, unknown> {
  return typeof scoreIntegrity === "string" &&
    RUN_SCORE_INTEGRITY.has(scoreIntegrity)
    ? { scoreIntegrity }
    : {};
}
