/**
 * The runner checks: what the runner measures at a stage on every iteration,
 * whether or not anyone authored anything there.
 *
 * NOT evaluators. They decide nothing and nobody writes them; each one reports
 * the verdict the stage analysis already reached for its stage. That is why
 * they render beside the evaluators in the same list and the same
 * EXPECTED / ACTUAL form, but wear a Built-in badge instead of a role, and why
 * they never become score rows (a row would move the evaluation config hash
 * and could fail a trial nobody asked it to gate).
 *
 * Names come from the SDK's `STANDARD_CHECKS` catalog, so the settings page,
 * the case page and the run page title them identically.
 */

import {
  STANDARD_CHECKS,
  type StageReason,
  type StandardCheck,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

export type RunnerCheck = Extract<StandardCheck, { kind: "runner" }>;
export type RunnerCheckStage = RunnerCheck["measuredBy"];

/** The badge a runner-check row wears where an evaluator wears its role. */
export const BUILT_IN_BADGE = "Built-in";

/** The stages that have a runner check, in chain order. */
export const RUNNER_CHECK_STAGES: readonly RunnerCheckStage[] = [
  "connection",
  "discovery",
  "call",
  "response",
];

export function isRunnerCheckStage(
  stage: UserValueStage,
): stage is RunnerCheckStage {
  return (RUNNER_CHECK_STAGES as readonly string[]).includes(stage);
}

const BY_STAGE = new Map(
  STANDARD_CHECKS.filter(
    (check): check is RunnerCheck => check.kind === "runner",
  ).map((check) => [check.measuredBy, check] as const),
);

export function runnerCheckOf(stage: RunnerCheckStage): RunnerCheck {
  const check = BY_STAGE.get(stage);
  // The catalog is a compile-time constant; a missing entry is a build error
  // in the SDK, not a state a page should render around.
  if (!check) throw new Error(`No runner check for stage "${stage}"`);
  return check;
}

/**
 * What each runner check expects, as the EXPECTED line of its row.
 *
 * Describes what the stage analysis decides for that stage, because that is
 * the verdict the row reports.
 */
export const RUNNER_CHECK_EXPECTED: Record<RunnerCheckStage, string> = {
  connection: "The run connects to its servers",
  discovery: "Each server lists its tools",
  call: "Each tool call returns a result",
  response: "Tool results come back without an error",
};

/**
 * The one failure each runner check owns: the reason the stage analysis gives
 * when the RUNNER's own measurement broke at that stage.
 *
 * A stage also fails for its evaluators — a required assertion that did not
 * hold (`predicateFailed`), arguments the matcher or a call assertion rejected
 * (`argumentMismatch`), a widget that did not render (`renderFailed`). Those
 * failures belong to the evaluator's row. Copied onto the runner check they
 * would say the call did not complete when it did, and put the same failure on
 * the stage twice.
 */
export const RUNNER_OWNED_FAILURE: Record<RunnerCheckStage, StageReason> = {
  connection: "connectFailed",
  discovery: "toolsListFailed",
  call: "protocolError",
  response: "toolError",
};
