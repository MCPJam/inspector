/**
 * Public projection of an iteration's stage evidence.
 *
 * The body lives in the SDK contract so the inspector client can apply the
 * same whitelist to a quick-run doc it already holds. This file stays the
 * server's import path so `toIterationDto` and the existing test are
 * untouched.
 */

import { projectStageDerivation } from "@mcpjam/sdk/contract";

export const toStageProjection = projectStageDerivation;
