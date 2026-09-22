/**
 * Finding constructors for the OpenAI checks.
 *
 * Checks never build an {@link OpenAIReadinessFinding} literal. Going through
 * these is what guarantees the fields that make a grade auditable — source
 * citation, provenance, intrusiveness, engine version, timestamp — are present
 * on every finding rather than on the ones whose author remembered.
 *
 * The constructors are the shared `directory-readiness` factory, bound ONCE
 * here to this product's engine version and its three type parameters.
 *
 * Pure data. No transport.
 */

import { createFindingConstructors } from "../../directory-readiness/helpers.js";
import type {
  DirectoryCheckDefinition,
  DirectoryCheckStamp,
} from "../../directory-readiness/helpers.js";
import type { OpenAIPolicySourceRef } from "../manifest.js";
import {
  OPENAI_READINESS_ENGINE_VERSION,
  type OpenAIReadinessLane,
  type OpenAIRunnerCapability,
} from "../types.js";

/** Everything about a check that does not depend on what it observed. */
export type OpenAICheckDefinition = DirectoryCheckDefinition<
  OpenAIReadinessLane,
  OpenAIPolicySourceRef,
  OpenAIRunnerCapability
>;

/** What every check is handed, so none of them reads a clock of its own. */
export type OpenAICheckStamp = DirectoryCheckStamp;

const constructors = createFindingConstructors<
  OpenAIReadinessLane,
  OpenAIPolicySourceRef,
  OpenAIRunnerCapability
>({ engineVersion: OPENAI_READINESS_ENGINE_VERSION });

export const satisfied = constructors.satisfied;
export const violated = constructors.violated;

/**
 * The requirement applies here but this run never exercised it.
 *
 * `reason` is not optional: an unevaluated requirement with no stated reason is
 * indistinguishable from a bug, and it is what makes a lane's `incomplete`
 * status actionable rather than mysterious.
 */
export const notEvaluated = constructors.notEvaluated;

/**
 * The requirement cannot apply to THIS submission — an archive rule against an
 * MCP-only submission, an endpoint rule against a skills-only one.
 *
 * The distinction from {@link notEvaluated} is the whole reason the submission
 * mode is an explicit input: nothing was left unverified here.
 */
export const notApplicable = constructors.notApplicable;

/** A statement that carries no pass/fail meaning — badges, observations. */
export const informational = constructors.informational;

export { derivedFrom } from "../../directory-readiness/helpers.js";

/**
 * The conventional key a finding uses to name the input that would close its
 * gap.
 *
 * The runner harvests `details.missingInput` into the lane's coverage, so a
 * check that spells the key differently produces a gap nobody is told how to
 * close. Naming it once removes the chance.
 */
export const MISSING_INPUT_DETAIL_KEY = "missingInput";

/** Build the `details` payload for a `not-evaluated` finding with a named gap. */
export function missingInput(
  name: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...extra, [MISSING_INPUT_DETAIL_KEY]: name };
}
