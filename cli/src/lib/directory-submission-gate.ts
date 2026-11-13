/**
 * A directory submission's check gate from the CLI: saving it, and judging a
 * run under it for the exit code.
 *
 * A lax gate passes what the directory's own set would fail, so whoever reads
 * a green build must see which checks it waived: every verdict names the
 * gate, and the checks a hosted run cannot check, with the reason.
 */
import type { Command } from "commander";
import {
  directorySubmissionConflict,
  getDirectorySubmissionOperation,
  updateDirectorySubmissionOperation,
  type GetDirectorySubmissionResultsResult,
  type PlatformApiClient,
  type PlatformDirectorySubmission,
  type UpdateDirectorySubmissionInput,
} from "@mcpjam/sdk/platform";
import {
  directoryReadinessExitCode,
  reportReadinessVerdict,
} from "./directory-readiness-exit-code.js";
import { CliError, setProcessExitCode, usageError } from "./output.js";

type Gate = PlatformDirectorySubmission["checkGate"];
type Results = GetDirectorySubmissionResultsResult;
type ClientContext = { client: PlatformApiClient; signal: AbortSignal };

export type GateChange = { failOn: string[]; warnOnly: string[]; clear: boolean };

/**
 * `--fail-on`, `--warn-only` and `--clear`, refused before anything is read
 * when they change nothing or put one check in both lists. The ids are held
 * to the operation's own schema.
 */
export function parseGateChange(
  options: { failOn: string[]; warnOnly: string[]; clear?: boolean },
  submission: string
): GateChange {
  const failOn = options.failOn.map((check) => check.trim());
  const warnOnly = options.warnOnly.map((check) => check.trim());
  if (failOn.length === 0 && warnOnly.length === 0 && !options.clear) {
    throw usageError("Nothing to change. Pass --fail-on, --warn-only or --clear.");
  }
  const both = failOn.find((check) => warnOnly.includes(check));
  if (both !== undefined) {
    throw usageError(`${both} is given to both --fail-on and --warn-only. Pass it to one of them.`);
  }
  const probe = { submission, checkGate: { failOn, warnOnly } };
  const parsed = updateDirectorySubmissionOperation.inputSchema.safeParse(probe);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw usageError(issues.join("; "));
  }
  return { failOn, warnOnly, clear: options.clear === true };
}

/** The gate after the change: a check moves to the list its flag names. */
function nextGate(current: Gate, change: GateChange): UpdateDirectorySubmissionInput["checkGate"] {
  const failOn = new Set<string>(change.clear ? [] : current?.failOn);
  const warnOnly = new Set<string>(change.clear ? [] : current?.warnOnly);
  for (const check of change.failOn) {
    failOn.add(check);
    warnOnly.delete(check);
  }
  for (const check of change.warnOnly) {
    warnOnly.add(check);
    failOn.delete(check);
  }
  // No exceptions is the directory's own set, which is no gate at all.
  if (failOn.size === 0 && warnOnly.size === 0) return null;
  return {
    ...(failOn.size > 0 ? { failOn: [...failOn] } : {}),
    ...(warnOnly.size > 0 ? { warnOnly: [...warnOnly] } : {}),
  };
}

/**
 * Apply the change to the gate as read, and save it against that revision. A
 * gate someone else saved in between is not overwritten: the refusal says so,
 * and running the command again applies the change to theirs.
 */
export async function saveGate(
  scope: { project?: string; submission: string },
  change: GateChange,
  context: ClientContext
) {
  const { submission } = await getDirectorySubmissionOperation.execute(scope, context);
  const checkGate = nextGate(submission.checkGate, change);
  const input = { ...scope, checkGate, expectedRevision: submission.revision };
  try {
    return await updateDirectorySubmissionOperation.execute(input, context);
  } catch (error) {
    const conflict = directorySubmissionConflict(error);
    if (!conflict) throw error;
    throw new CliError(
      "CONFLICT",
      "This submission's check gate changed while yours was saving. Run the command again to apply your change to the new gate.",
      1,
      {
        currentRevision: conflict.currentRevision,
        conflictingKeys: conflict.conflictingKeys,
        checkGate: conflict.current?.checkGate ?? null,
      }
    );
  }
}

/** On stderr, so stdout stays the JSON result; `--quiet` drops it. */
function report(command: Command, lines: string[]): void {
  if (command.optsWithGlobals().quiet) return;
  process.stderr.write(`${lines.join("\n")}\n`);
}

function gateLines(gate: Gate): string[] {
  const lines = ["Gate: the directory's blocking checks"];
  if (gate?.failOn?.length) lines.push(`  Also fail on: ${gate.failOn.join(", ")}`);
  if (gate?.warnOnly?.length) lines.push(`  Warn only: ${gate.warnOnly.join(", ")}`);
  return lines;
}

export function reportGate(gate: Gate, command: Command): void {
  report(command, gateLines(gate));
}

/** What kept a verdict from ready, for the verdict line. */
function verdictSummary(results: Results): string | undefined {
  const { verdict, failing, undetermined } = results.verdict;
  if (verdict === "ready") return undefined;
  if (verdict === "not-ready") return `checks in the gate failed: ${failing.join(", ")}`;
  if (results.run === null) {
    return `no run has completed. Start one with \`mcpjam readiness submission run ${results.submissionId} --wait\`.`;
  }
  return undetermined.length > 0
    ? `checks in the gate have no current result: ${undetermined.join(", ")}`
    : "the run reported no check in the gate";
}

/**
 * The verdict under the submission's gate, the gate it applied and what a
 * hosted run cannot check, then the readiness exit code.
 */
export function judgeResults(results: Results, command: Command): void {
  const { verdict } = results;
  reportReadinessVerdict({ status: verdict.verdict, summary: verdictSummary(results) }, command);
  const skipped = verdict.notCheckedOnPath.map(
    (check) => `  ${check}: ${verdict.notCheckedReasons[check]}`
  );
  report(command, [
    ...gateLines(verdict.gate),
    ...(skipped.length > 0 ? [`Not checked on hosted runs (${skipped.length}):`, ...skipped] : []),
  ]);
  setProcessExitCode(directoryReadinessExitCode({ status: verdict.verdict }));
}

/**
 * Where the exit code is a verdict, a failure other than a usage error
 * decided nothing: 3, never the 1 that means not ready.
 */
export async function withVerdictExit(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode === 2) throw error;
    throw new CliError(error.code, error.message, 3, error.details);
  }
}
