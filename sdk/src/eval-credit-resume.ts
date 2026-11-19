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

/** Where a stopped run executed, read from its own record. */
export interface EvalResumeSource {
  suiteId?: string;
  environmentId?: string;
  hostId?: string;
}

/**
 * The suite and target a stopped run executed on, from the run record (its
 * immutable config snapshot), so a resume lands on the same target even if the
 * suite's attachments changed since. A suite-default client is not a
 * selectable target, so it is omitted.
 */
export function resumeSourceOfRun(run: {
  suiteId?: string;
  environment?: { id: string } | null;
  client?: { id: string | null; source: string };
}): EvalResumeSource {
  const hostId =
    run.client?.source === "attached_host" && run.client.id
      ? run.client.id
      : undefined;
  return {
    ...(run.suiteId ? { suiteId: run.suiteId } : {}),
    ...(run.environment?.id ? { environmentId: run.environment.id } : {}),
    ...(hostId ? { hostId } : {}),
  };
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * The idempotency key to re-launch ONE refused target of a fan-out with.
 *
 * Distinct per target: re-launching two refused targets under the group's own
 * key would make the second dedupe onto the first one's run. Deterministic, so
 * running the same resume twice still starts the run once. The group key is
 * shortened, never the target id, to stay inside the key limit.
 */
export function resumeIdempotencyKeyForTarget(
  groupKey: string,
  targetId: string
): string {
  const suffix = `:${targetId}`;
  return `${groupKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - suffix.length)}${suffix}`;
}

/** The MCP tool call that resumes a credit-blocked eval once a person acts. */
export interface EvalResumeInstruction {
  tool: "run_eval_suite";
  arguments: Record<string, unknown>;
}

/**
 * Resume a run credits stopped partway: the same suite and target, with
 * `resumeFromRunId`, which reruns only the source run's unfinished cases.
 * Cases and target lists are left out because the backend refuses them beside
 * a resume.
 */
export function stoppedRunResumeInstruction(
  projectId: string,
  run: {
    id: string;
    suiteId: string;
    environment?: { id: string } | null;
    client?: { id: string | null; source: string };
  }
): EvalResumeInstruction {
  const source = resumeSourceOfRun(run);
  return {
    tool: "run_eval_suite",
    arguments: {
      project: projectId,
      suite: run.suiteId,
      ...(source.environmentId
        ? { environment: source.environmentId }
        : source.hostId
          ? { client: source.hostId }
          : {}),
      resumeFromRunId: run.id,
    },
  };
}

/** `run_eval_suite` fields that pick targets; a per-target resume replaces them. */
const TARGET_SELECTOR_FIELDS: ReadonlySet<string> = new Set([
  "servers",
  "environment",
  "environments",
  "client",
  "clients",
  "host",
  "hosts",
  "allAttached",
  "compose",
  "saveTargets",
  "idempotencyKey",
  "resumeFromRunId",
]);

/**
 * Re-launch one target of a fan-out that credits refused before it created a
 * run: the same launch narrowed to that target. The group key, when there was
 * one, becomes a per-target key (see {@link resumeIdempotencyKeyForTarget}).
 */
export function refusedTargetResumeInstruction(
  launch: { projectId: string; suiteId: string; input: object },
  target: { environmentId?: string; hostId?: string }
): EvalResumeInstruction {
  const knobs = Object.fromEntries(
    Object.entries(launch.input).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "project" &&
        key !== "suite" &&
        !TARGET_SELECTOR_FIELDS.has(key)
    )
  );
  const groupKey = (launch.input as { idempotencyKey?: unknown })
    .idempotencyKey;
  const targetId = target.environmentId ?? target.hostId ?? "";
  return {
    tool: "run_eval_suite",
    arguments: {
      project: launch.projectId,
      suite: launch.suiteId,
      ...(target.environmentId
        ? { environment: target.environmentId }
        : target.hostId
          ? { client: target.hostId }
          : {}),
      ...knobs,
      ...(typeof groupKey === "string" && groupKey
        ? { idempotencyKey: resumeIdempotencyKeyForTarget(groupKey, targetId) }
        : {}),
    },
  };
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

const INCOMPLETE_CASES_PAGE_LIMIT = 200;

/**
 * The unfinished cases of a credit-stopped run, from one page of trials, or
 * `undefined` when the read fails: the list is advisory and must not fail the
 * status read it rides on.
 */
export async function readEvalRunIncompleteCases(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal | undefined,
  projectId: string,
  runId: string
): Promise<IncompleteEvalCases | undefined> {
  try {
    const page = await client.listEvalRunIterations(
      { projectId, runId, limit: INCOMPLETE_CASES_PAGE_LIMIT },
      { signal }
    );
    return incompleteCasesOfIterations(page.items, Boolean(page.nextCursor));
  } catch {
    // Safe to drop: the caller still has the recovery and the resume
    // instruction, which are what unblock the run; the list only previews it.
    return undefined;
  }
}
