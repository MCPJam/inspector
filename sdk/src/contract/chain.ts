/**
 * The Wave-0 vocabulary for the user-value chain.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * These are ENUMS ONLY — the words every downstream surface agrees to use.
 * Deriving a stage's state from a run, or the row shape that derivation
 * produces, is deliberately NOT here: pinning the vocabulary is Wave 0's job,
 * pinning the derivation output belongs to whoever writes the derivation. What
 * matters now is that the mirroring Convex validators, the reporting surfaces
 * and the importers all spell these the same way.
 *
 * Each list is a `const` array plus a derived type plus a zod enum, the same
 * pattern `TEST_STEP_KINDS` uses, so a new member cannot be added in one place
 * and forgotten in another.
 */

import { z } from "zod";

/**
 * The user-value chain, in CHAIN ORDER.
 *
 * **The array order is normative and must never be reordered or sorted.** A run
 * walks these stages in sequence, and "not reached" is derived from POSITION:
 * every stage after the first failed one was never reached. Sorting this array
 * alphabetically — or inserting a stage in the wrong slot — silently changes
 * which stages a failure is reported to have blocked.
 *
 *   - `connection`  — the server was reachable and the session initialized.
 *   - `discovery`   — its tools/resources were listed and readable.
 *   - `selection`   — the model chose the right tool for the request.
 *   - `call`        — the call was made with usable arguments.
 *   - `response`    — the server returned data the model could use.
 *   - `userValue`   — the user's actual request was satisfied.
 */
export const USER_VALUE_STAGES = [
  "connection",
  "discovery",
  "selection",
  "call",
  "response",
  "userValue",
] as const;
export type UserValueStage = (typeof USER_VALUE_STAGES)[number];
export const userValueStageSchema = z.enum(USER_VALUE_STAGES);

/**
 * What a stage did, for one run.
 *
 * These are STRINGS on the wire and in storage. No numeric encoding is exported
 * from here, and none should be introduced: an ordinal encoding invites
 * comparison (`state > 0`), and `notMeasured` vs `notApplicable` vs `notReached`
 * are not points on a scale — they are three different reasons there is no
 * verdict, and collapsing them is how "we never checked" gets rendered as
 * "it passed".
 *
 *   - `passed`        — measured, and it worked.
 *   - `failed`        — measured, and it did not.
 *   - `notReached`    — an earlier stage failed, so this one never ran.
 *   - `notMeasured`   — this run captured nothing that could decide it.
 *   - `notApplicable` — the stage does not apply to this case at all.
 */
export const STAGE_STATES = [
  "passed",
  "failed",
  "notReached",
  "notMeasured",
  "notApplicable",
] as const;
export type StageState = (typeof STAGE_STATES)[number];
export const stageStateSchema = z.enum(STAGE_STATES);

/**
 * Where the blame for a failure sits — the coarse bucket a failing run is
 * grouped under when someone asks "what is actually broken?".
 *
 *   - `setup`       — the harness/environment never got to the test.
 *   - `metadata`    — tool names, descriptions or schemas misled the model.
 *   - `selection`   — the model picked the wrong tool (or none).
 *   - `arguments`   — the right tool, called wrongly.
 *   - `serverData`  — the server answered, but with unusable data.
 *   - `userValue`   — everything mechanical worked; the user still wasn't served.
 *   - `evaluator`   — the grader itself failed, so the run says nothing about
 *     the server. Never folded into the others: a broken judge is not a
 *     server defect, and counting it as one poisons every rate derived from it.
 */
export const FAILURE_CATEGORIES = [
  "setup",
  "metadata",
  "selection",
  "arguments",
  "serverData",
  "userValue",
  "evaluator",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);

/**
 * The lifecycle of one iteration.
 *
 * The first six mirror the persisted union in `mcpjam-backend`
 * (`convex/schema.ts`, `evalIterations.status`) EXACTLY, in that order.
 * `setup_failed` and `skipped` are the additions this contract pins:
 *
 *   - `setup_failed` — the iteration never began because its environment could
 *     not be prepared. A `failed` iteration says something about the server;
 *     this one says something about us, and merging the two inflates every
 *     failure rate with harness noise.
 *   - `skipped` — deliberately not run (a disabled case, a filtered selection).
 *     Distinct from `cancelled`, which is a run that was stopped mid-flight.
 *
 * Mirroring this list into the backend union is a separate change: extending
 * the stored union is the backend's to make, and this file is the source it
 * mirrors from.
 */
export const ITERATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "setup_failed",
  "skipped",
] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];
export const iterationStatusSchema = z.enum(ITERATION_STATUSES);

/**
 * How faithfully an imported case reproduces its source.
 *
 * Recorded per case so an imported suite can be audited rather than trusted:
 *
 *   - `exact`        — the source construct maps onto ours by a cited
 *     structural rule, with nothing dropped or invented.
 *   - `approximated` — it runs, but the mapping lost or guessed something.
 *     **This is the pessimistic default at every write boundary**: `exact` is a
 *     claim that must be earned by a rule, and "I could not find a rule" is
 *     `approximated`, never `exact`.
 *   - `unsupported`  — the source construct has no counterpart here. Preserved
 *     in the mapping report, never smuggled into the executable suite as a
 *     weakened assertion.
 *   - `unresolved`   — something the case references (a tool name, a server, a
 *     fixture) did not resolve against live discovery. **This one is decided by
 *     CODE, not by the caller**: the validator re-resolves every reference
 *     itself, so a converter can neither claim it nor claim its way out of it.
 *
 * `unsupported` and `unresolved` are also the two that cannot be accepted into
 * eligibility. An `approximated` case can run once a human accepts the
 * documented semantic difference; these two must be repaired and revalidated
 * first, because there is nothing coherent to accept.
 */
export const IMPORT_MAPPING_STATUSES = [
  "exact",
  "approximated",
  "unsupported",
  "unresolved",
] as const;
export type ImportMappingStatus = (typeof IMPORT_MAPPING_STATUSES)[number];
export const importMappingStatusSchema = z.enum(IMPORT_MAPPING_STATUSES);
