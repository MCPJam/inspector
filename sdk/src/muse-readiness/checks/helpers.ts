/**
 * Finding constructors, bound once to Muse's engine version.
 *
 * Checks never build a finding literal: going through these is what puts a
 * source citation, provenance, intrusiveness, engine version and timestamp on
 * every finding rather than on the ones whose author remembered.
 *
 * Pure data. No transport.
 */

import { createFindingConstructors } from "../../directory-readiness/helpers.js";
import type {
  DirectoryCheckDefinition,
  DirectoryCheckStamp,
} from "../../directory-readiness/helpers.js";
import type { MusePolicySourceRef } from "../manifest.js";
import {
  MUSE_READINESS_ENGINE_VERSION,
  type MuseReadinessLane,
  type MuseRunnerCapability,
} from "../types.js";

/** Everything about a check that does not depend on what it observed. */
export type MuseCheckDefinition = DirectoryCheckDefinition<
  MuseReadinessLane,
  MusePolicySourceRef,
  MuseRunnerCapability
>;

/** What every check is handed, so none of them reads a clock of its own. */
export type MuseCheckStamp = DirectoryCheckStamp;

const constructors = createFindingConstructors<
  MuseReadinessLane,
  MusePolicySourceRef,
  MuseRunnerCapability
>({ engineVersion: MUSE_READINESS_ENGINE_VERSION });

export const satisfied = constructors.satisfied;
export const violated = constructors.violated;
export const notEvaluated = constructors.notEvaluated;
export const notApplicable = constructors.notApplicable;
export const informational = constructors.informational;

/** The named inputs a caller can supply to close a coverage gap. */
export const MUSE_READINESS_INPUTS = {
  submissionProfile: "submissionProfile",
  toolListing: "toolListing",
} as const;
