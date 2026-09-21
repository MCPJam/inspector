/**
 * Public projection of an iteration's friction signals.
 *
 * The body lives in the SDK contract so the inspector client can apply the
 * same whitelist to a run doc it already holds. This file is the server's
 * import path, exactly like `./eval-stage-projection.ts` next door, so
 * `toIterationDto` reads one name per projection rather than reaching into
 * the contract module directly.
 */

import {
  projectFrictionSignals,
  projectSuspectedConditionVerdict,
} from "@mcpjam/sdk/contract";

export const toFrictionSignalsProjection = projectFrictionSignals;

/**
 * Step 2's advisory verdict, projected the same way.
 *
 * Beside the signals rather than inside them: the judge only ever runs where a
 * signal already fired, but the two are written by different systems at
 * different times, and a reader must be able to tell "flagged, not yet judged"
 * from "judged, and it could not attribute".
 */
export const toSuspectedConditionProjection = projectSuspectedConditionVerdict;
