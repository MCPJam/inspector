import {
  parseCreditRecovery,
  type CreditRecovery,
} from "./contract/credit-recovery.js";
import type { PlatformApiClient } from "./platform/client.js";
import type { PlatformEvalIteration } from "./platform/types.js";

/**
 * What an agent needs after MCPJam credits block an eval: the exact call that
 * resumes it once a person has taken the one step, and which cases that call
 * will run. Shared by the MCP tools and the CLI so both name the same target,
 * key and case list.
 *
 * A `wait` recovery is not a block: steering an agent toward waiting is what
 * the one-action rule removes. Every other action needs a person, so it is a
 * block and gets a resume instruction.
 */

/** True when the recovery names a step a PERSON must take (anything but `wait`). */
export function isCreditBlock(
  recovery: CreditRecovery | undefined
): recovery is CreditRecovery {
  return recovery !== undefined && recovery.action !== "wait";
}

/** The suite a stopped run belongs to, read from its own record. */
export interface EvalResumeSource {
  suiteId?: string;
}

/**
 * The suite a stopped run belongs to. Its target is deliberately not read:
 * a resume names no target, and the backend runs it on the source run's own
 * target, including a composed or since-detached environment that no launch
 * selector could name.
 */
export function resumeSourceOfRun(run: { suiteId?: string }): EvalResumeSource {
  return run.suiteId ? { suiteId: run.suiteId } : {};
}

/** The MCP tool call that resumes a credit-blocked eval once a person acts. */
export interface EvalResumeInstruction {
  tool: "run_eval_suite";
  arguments: Record<string, unknown>;
}

/**
 * Resume a run credits stopped partway: the same suite with
 * `resumeFromRunId`, which reruns only the source run's unfinished cases on
 * the source run's own target. Cases and targets are left out because the
 * backend refuses cases beside a resume and inherits the target itself.
 */
export function stoppedRunResumeInstruction(
  projectId: string,
  run: { id: string; suiteId: string }
): EvalResumeInstruction {
  return {
    tool: "run_eval_suite",
    arguments: {
      project: projectId,
      suite: run.suiteId,
      resumeFromRunId: run.id,
    },
  };
}

/**
 * Re-run a launch credits refused before it created a run: the same call
 * again, with the suite and project by id and the same idempotency key. For
 * a fan-out the server derives each target's run key from the group key, so
 * the replay returns the targets that started as their existing runs and
 * launches only the ones that were refused. Every selector, compose recipe
 * and knob is kept, because changing any of them would be a different launch.
 * A refused resume keeps its `resumeFromRunId`: without it the replay would
 * run the whole suite, cases the stopped run already finished included.
 */
export function replayLaunchResumeInstruction(launch: {
  projectId: string;
  suiteId: string;
  input: object;
}): EvalResumeInstruction {
  const knobs = Object.fromEntries(
    Object.entries(launch.input).filter(
      ([key, value]) =>
        value !== undefined && key !== "project" && key !== "suite"
    )
  );
  return {
    tool: "run_eval_suite",
    arguments: { project: launch.projectId, suite: launch.suiteId, ...knobs },
  };
}

/**
 * The launch input a fan-out sends, with an idempotency key minted when the
 * caller gave none. Without a key the server picks a random group id and no
 * per-target keys, so a refused target's replay could not tell which siblings
 * already started; a fresh key per launch keeps every launch distinct.
 */
export function withGroupLaunchKey<T extends { idempotencyKey?: string }>(
  input: T
): T {
  return input.idempotencyKey
    ? input
    : { ...input, idempotencyKey: globalThis.crypto.randomUUID() };
}

/** One case a resume will run again. */
export interface IncompleteEvalCase {
  caseId?: string;
  testCaseId: string | null;
  title: string | null;
}

/** The cases a credit stop left unfinished, bounded. */
export interface IncompleteEvalCases {
  cases: IncompleteEvalCase[];
  /** More unfinished cases exist than are listed (or than one page read). */
  truncated: boolean;
}

/** Most cases listed; the rest are counted by `truncated` only. */
export const INCOMPLETE_CASES_LIMIT = 20;

/** Trial statuses that mean the trial never ran to an end. */
const UNFINISHED_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "skipped",
  "cancelled",
]);

function trialUnfinished(
  iteration: Pick<PlatformEvalIteration, "status" | "infraError">
): boolean {
  return (
    UNFINISHED_STATUSES.has(iteration.status) ||
    parseCreditRecovery(iteration.infraError?.recovery) !== undefined
  );
}

/**
 * The distinct cases with a trial a credit stop interrupted or skipped, in
 * trial order. A case with one finished and one unfinished trial counts: the
 * resume reruns the whole case.
 */
export function incompleteCasesOfIterations(
  iterations: readonly Pick<
    PlatformEvalIteration,
    "status" | "infraError" | "caseId" | "testCaseId" | "title"
  >[],
  pageTruncated = false
): IncompleteEvalCases {
  const seen = new Set<string>();
  const cases: IncompleteEvalCase[] = [];
  let truncated = pageTruncated;
  for (const iteration of iterations) {
    if (!trialUnfinished(iteration)) continue;
    const key = iteration.testCaseId ?? iteration.caseId ?? iteration.title;
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    if (cases.length === INCOMPLETE_CASES_LIMIT) {
      truncated = true;
      break;
    }
    cases.push({
      ...(iteration.caseId ? { caseId: iteration.caseId } : {}),
      testCaseId: iteration.testCaseId,
      title: iteration.title,
    });
  }
  return { cases, truncated };
}

/** The exact cases a resume of a stopped run will launch, as the backend chose them. */
export interface EvalResumeSelection {
  caseIds: string[];
  totalCaseCount: number;
}

/** The run read's `resumeSelection`, or `undefined` when absent or malformed. */
export function parseResumeSelection(
  value: unknown
): EvalResumeSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { caseIds, totalCaseCount } = value as Record<string, unknown>;
  if (
    !Array.isArray(caseIds) ||
    !caseIds.every((id): id is string => typeof id === "string") ||
    typeof totalCaseCount !== "number"
  ) {
    return undefined;
  }
  return { caseIds, totalCaseCount };
}

/**
 * The cases a resume of this run will rerun. The backend's own selection wins
 * when the run read carries one, because it is the list the resume launches;
 * trials only supply titles then. Without it (an older deployment) the
 * preview falls back to the trials a credit stop left unfinished.
 */
export function incompleteCasesOfRun(
  run: { resumeSelection?: unknown },
  iterations: Parameters<typeof incompleteCasesOfIterations>[0],
  pageTruncated = false
): IncompleteEvalCases {
  const selection = parseResumeSelection(run.resumeSelection);
  if (!selection) return incompleteCasesOfIterations(iterations, pageTruncated);
  const titles = new Map<string, string | null>();
  for (const iteration of iterations) {
    if (iteration.testCaseId) titles.set(iteration.testCaseId, iteration.title);
  }
  return {
    cases: selection.caseIds.slice(0, INCOMPLETE_CASES_LIMIT).map((id) => ({
      testCaseId: id,
      title: titles.get(id) ?? null,
    })),
    truncated: selection.caseIds.length > INCOMPLETE_CASES_LIMIT,
  };
}

const INCOMPLETE_CASES_PAGE_LIMIT = 200;

/**
 * The unfinished cases of a credit-stopped run, from its resume selection and
 * one page of trials, or `undefined` when there is no selection and the read
 * fails: the list is advisory and must not fail the status read it rides on.
 */
export async function readEvalRunIncompleteCases(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal | undefined,
  projectId: string,
  run: { id: string; resumeSelection?: unknown }
): Promise<IncompleteEvalCases | undefined> {
  try {
    const page = await client.listEvalRunIterations(
      { projectId, runId: run.id, limit: INCOMPLETE_CASES_PAGE_LIMIT },
      { signal }
    );
    return incompleteCasesOfRun(run, page.items, Boolean(page.nextCursor));
  } catch {
    // Safe to drop: the caller still has the recovery and the resume
    // instruction, which are what unblock the run. The selection, when the
    // run read carried one, still lists the cases, only without titles.
    return parseResumeSelection(run.resumeSelection)
      ? incompleteCasesOfRun(run, [])
      : undefined;
  }
}
