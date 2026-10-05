// Persisted re-grade of a completed run from its stored traces.
//
// The backend cannot evaluate a predicate, so the inspector does the grading:
// it reads the run's frozen evidence page by page, rebuilds each iteration's
// verdict through the live verdict boundary (`storedTraceVerdict` →
// `buildEvalIterationVerdict`), and — unless this is a dry run — hands the
// verdicts that changed to the backend, which persists them under an
// optimistic-concurrency guard and re-decides the run.
//
// NO MODEL CALL, NO FEE. Everything here is a pure function of stored evidence.
// The judge in particular is never re-asked: an iteration whose verdict the
// judge or the score contract decided (authoritative score rows) is skipped,
// and a judge downgrade is carried, never re-graded into a pass.
//
// TRUST BEFORE CHANGE. An iteration is re-graded only when the stored trace
// REPRODUCES the verdict that was recorded: the recorded check rows are first
// replayed through the same boundary, and if that does not land on the stored
// result, the verdict depended on evidence the trace does not carry (a pinned
// tool error, a widget check, a matcher that has since changed) and the
// iteration is left exactly as it was. What a re-grade changes is therefore
// attributable to the assertion change alone.
//
// Checks a trace cannot evaluate — render observations, token usage, anything
// that reports `status: "error"` for want of a tool inventory — keep their
// recorded rows when the same rule was recorded, and otherwise skip the
// iteration rather than fail it for evidence nobody captured.

import { canonicalDigest } from "@mcpjam/sdk/contract";
import type {
  EvalBacktestDraft,
  EvalRegradeIteration,
  EvalRegradeReport,
} from "../../../../sdk/src/contract/eval-backtest.js";
import type {
  EvalMatchOptions,
  Predicate,
  PredicateResult,
  ToolCall,
} from "@/shared/eval-matching";
import { draftAssertionRules } from "./assertion-backtest.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import {
  storedTraceVerdict,
  type StoredTraceVerdictInputs,
} from "./stored-trace-verdict.js";
import type { AgentActivityAssessment } from "./agent-activity.js";

/** Evidence rows per page; the backend's own cap. */
export const REGRADE_PAGE_SIZE = 5;
/** Iterations one re-grade will read. A larger run is refused, not truncated. */
export const REGRADE_MAX_ITERATIONS = 1000;
/** Iterations per persisted batch; the backend's own cap. */
export const REGRADE_WRITE_BATCH = 25;
const REGRADE_DEADLINE_MS = 120_000;

/** One row of `evalRegrade:readRegradeEvidence`. */
export type RegradeEvidenceRow = {
  iterationId: string;
  caseId: string;
  status: string;
  result: string;
  updatedAt: number;
  gradingRevision: number;
  error?: string;
  actualToolCalls?: ToolCall[];
  expectedToolCalls?: ToolCall[];
  isNegativeTest?: boolean;
  query?: string;
  predicates?: unknown;
  matchOptions?: unknown;
  failOnToolError?: boolean;
  caseShape?: { turns: number; transcriptOnly: boolean };
  recorded?: {
    predicateResults?: unknown[];
    scoreRows?: "authoritative" | "none";
    verdictDowngradedBy?: string;
    agentActivity?: unknown;
  };
  evidence?: {
    traceVersion?: number;
    traceComplete?: boolean;
    messages?: Array<{ role: string; content: unknown }>;
    spans?: unknown[];
  } | null;
  completeness?: { transcript?: string; reason?: string };
};

export type RegradeEvidencePage = {
  schemaVersion: 1;
  runId: string;
  suiteId: string;
  isDone: boolean;
  cursor?: string;
  iterations: RegradeEvidenceRow[];
};

export type RegradeWrite = {
  iterationId: string;
  expectedGradingRevision: number;
  expectedUpdatedAt: number;
  result: "passed" | "failed";
  predicateResults: PredicateResult[];
};

export type RegradeApplyResponse = {
  regraded: number;
  flipped: number;
  result?: string;
  summary?: NonNullable<EvalRegradeReport["run"]>["summary"];
  verdict?: string;
  iterations: Array<{ iterationId: string; gradingRevision: number }>;
};

/** One iteration, re-graded or not. */
export type RegradeIterationOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "graded";
      result: "passed" | "failed";
      predicateResults: PredicateResult[];
      carriedChecks: number;
      changed: boolean;
    };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Kinds whose evidence a stored trace never carries. */
function traceCannotEvaluate(rule: Predicate): boolean {
  return rule.type.startsWith("widget") || rule.type === "tokenBudgetUnder";
}

/** A recorded row, if it is one. */
function readRecordedRow(value: unknown): PredicateResult | undefined {
  return record(value) &&
    typeof value.passed === "boolean" &&
    record(value.predicate) &&
    typeof value.predicate.type === "string"
    ? (value as unknown as PredicateResult)
    : undefined;
}

/** Rule identity for carrying a recorded row: `required` is the absent role. */
function ruleDigest(rule: unknown): string {
  // Recorded rules crossed the Convex transport escaped (`$schema` keys).
  const escaped = sanitizeForConvexTransport(rule);
  if (!record(escaped)) return "";
  const { role, ...rest } = escaped;
  return digestOf(role === "advisory" ? { ...rest, role } : rest) ?? "";
}

function digestOf(value: unknown): string | undefined {
  try {
    return canonicalDigest(value);
  } catch {
    return undefined;
  }
}

/**
 * Re-grade one recorded iteration against the draft's rules. Pure.
 *
 * Returns `skipped` with a reason for every iteration the stored evidence
 * cannot honestly re-grade; nothing about such an iteration is written.
 */
export function regradeIteration(
  row: RegradeEvidenceRow,
  draft: Pick<EvalBacktestDraft, "assertions">,
): RegradeIterationOutcome {
  const skip = (reason: string): RegradeIterationOutcome => ({
    kind: "skipped",
    reason,
  });
  // Lifecycle first: a trial that never completed (an infrastructure error,
  // a timeout, a cancellation) has no verdict to re-grade.
  if (row.status !== "completed")
    return skip("Only completed iterations are re-graded");
  if (row.result !== "passed" && row.result !== "failed")
    return skip("The iteration carries no verdict");
  if (row.recorded?.scoreRows === "authoritative")
    return skip(
      "Authoritative score rows decide this iteration; re-grade does not re-project them",
    );
  if (row.caseShape && !row.caseShape.transcriptOnly)
    return skip(
      "The case ran pinned tool calls, widget interactions or DOM assertions, which a stored trace cannot replay",
    );
  if (row.caseShape && row.caseShape.turns > 1)
    return skip("Per-turn tool-call attribution is not recorded");
  const evidence = row.evidence;
  if (
    !evidence ||
    evidence.traceVersion !== 1 ||
    evidence.traceComplete !== true ||
    row.completeness?.transcript !== "complete"
  )
    return skip(
      `Transcript capture is incomplete${
        row.completeness?.reason ? ` (${row.completeness.reason})` : ""
      }`,
    );
  if (
    !Array.isArray(row.actualToolCalls) ||
    !Array.isArray(row.expectedToolCalls)
  )
    return skip("Recorded tool calls or frozen expectations are unavailable");

  const recordedRows = row.recorded?.predicateResults ?? [];
  const recorded = recordedRows.map(readRecordedRow);
  if (recorded.some((value) => value === undefined))
    return skip("Recorded check results are unreadable");
  const stored = recorded as PredicateResult[];
  const storedCase = stored.filter((result) => result.scope === undefined);
  const storedTurn = stored.filter((result) => result.scope !== undefined);

  // Absent frozen rules mean none were configured — unless rows say otherwise.
  const frozen =
    row.predicates === undefined && storedCase.length === 0
      ? []
      : row.predicates;
  const rules = draftAssertionRules({ predicates: frozen }, draft);
  if (!rules) return skip("Frozen assertion configuration is unavailable");
  if (draft.assertions.mode !== "replace") {
    // The frozen half must be what was actually evaluated, or "inherit" would
    // quietly swap the rules the recorded verdict was decided by.
    const frozenTypes = rules
      .slice(
        0,
        rules.length -
          (draft.assertions.mode === "extend"
            ? draft.assertions.list.length
            : 0),
      )
      .map((rule) => rule.type);
    const recordedTypes = storedCase.map((result) => result.predicate.type);
    if (frozenTypes.join("\n") !== recordedTypes.join("\n"))
      return skip("The recorded checks do not match the frozen assertions");
  }

  const activity = row.recorded?.agentActivity;
  const inputs: StoredTraceVerdictInputs = {
    ...(row.query !== undefined ? { query: row.query } : {}),
    expectedToolCalls: row.expectedToolCalls,
    actualToolCalls: row.actualToolCalls,
    isNegativeTest: row.isNegativeTest === true,
    ...(record(row.matchOptions)
      ? { matchOptions: row.matchOptions as EvalMatchOptions }
      : {}),
    messages: evidence.messages ?? [],
    spans: evidence.spans ?? [],
    ...(row.error !== undefined ? { iterationError: row.error } : {}),
    ...(row.failOnToolError !== undefined
      ? { failOnToolError: row.failOnToolError }
      : {}),
    // Recorded only when the guard fired, so its presence IS the assessment.
    ...(record(activity) && activity.status === "no_agent_activity"
      ? { agentActivity: activity as unknown as AgentActivityAssessment }
      : {}),
  };

  // (1) Parity. The recorded rows, replayed through the boundary, must land on
  // the recorded verdict. A judge downgrade only ever lands on a pass.
  const judgeDowngraded = row.recorded?.verdictDowngradedBy === "judge";
  const recordedDeterministic = judgeDowngraded ? "passed" : row.result;
  const replay = storedTraceVerdict(inputs, { turnCheckResults: stored });
  if ((replay.passed ? "passed" : "failed") !== recordedDeterministic)
    return skip(
      "The recorded verdict is not reproducible from the stored trace; it depended on evidence the trace does not carry",
    );

  // (2) The draft's rules, evaluated against the stored transcript.
  const fresh = storedTraceVerdict(inputs, {
    effectivePredicates: rules,
  }).predicateResults.slice(0, rules.length);
  let carriedChecks = 0;
  const finalCase: PredicateResult[] = [];
  for (const [index, rule] of rules.entries()) {
    const result = fresh[index];
    if (result && !traceCannotEvaluate(rule) && result.status !== "error") {
      finalCase.push(result);
      continue;
    }
    const digest = ruleDigest(rule);
    const kept = digest
      ? storedCase.find(
          (candidate) => ruleDigest(candidate.predicate) === digest,
        )
      : undefined;
    if (!kept)
      return skip(
        `Check "${rule.type}" cannot be evaluated from the stored trace and has no recorded result`,
      );
    finalCase.push(kept);
    carriedChecks += 1;
  }

  // (3) The verdict, from the settled rows. Per-turn rows are recorded step
  // facts and are kept as they were.
  const verdict = storedTraceVerdict(inputs, {
    turnCheckResults: [...finalCase, ...storedTurn],
  });
  const result: "passed" | "failed" =
    verdict.passed && !judgeDowngraded ? "passed" : "failed";
  // Escaped for Convex the way the runner's own write escapes them, so a
  // re-grade that changed nothing compares equal to what is stored.
  const predicateResults = sanitizeForConvexTransport(verdict.predicateResults);
  const changed =
    result !== row.result ||
    digestOf(predicateResults) === undefined ||
    digestOf(predicateResults) !== digestOf(stored);
  return { kind: "graded", result, predicateResults, carriedChecks, changed };
}

/** Run one awaited step under the request's deadline and abort signal. */
async function bounded<T>(
  work: () => Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw new Error("Re-grade cancelled");
  if (Date.now() > deadline) throw new Error("Re-grade deadline exceeded");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Re-grade cancelled"));
        signal?.addEventListener("abort", cancel, { once: true });
        timeout = setTimeout(
          () => reject(new Error("Re-grade deadline exceeded")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Re-grade a completed run. Reads EVERY page before writing anything, so a run
 * that cannot be read whole is refused rather than half re-graded.
 */
export async function runRegrade(input: {
  runId: string;
  suiteId: string;
  draft: Pick<EvalBacktestDraft, "assertions">;
  dryRun: boolean;
  readPage: (args: Record<string, unknown>) => Promise<RegradeEvidencePage>;
  applyBatch: (args: {
    runId: string;
    draftHash: string;
    iterations: RegradeWrite[];
  }) => Promise<RegradeApplyResponse>;
  signal?: AbortSignal;
}): Promise<EvalRegradeReport> {
  const deadline = Date.now() + REGRADE_DEADLINE_MS;
  const draft: Pick<EvalBacktestDraft, "assertions"> = JSON.parse(
    JSON.stringify({ assertions: input.draft.assertions }),
  );
  const draftHash = canonicalDigest(draft);
  const rows: RegradeEvidenceRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await bounded(
      () =>
        input.readPage({
          runId: input.runId,
          pageSize: REGRADE_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
      deadline,
      input.signal,
    );
    if (
      page?.schemaVersion !== 1 ||
      page.runId !== input.runId ||
      typeof page.isDone !== "boolean" ||
      !Array.isArray(page.iterations) ||
      page.iterations.length > REGRADE_PAGE_SIZE
    )
      throw new Error("Invalid re-grade evidence response");
    for (const row of page.iterations) {
      if (!row.iterationId || seen.has(row.iterationId))
        throw new Error("Duplicate or invalid re-grade iteration identity");
      seen.add(row.iterationId);
      rows.push(row);
    }
    if (rows.length > REGRADE_MAX_ITERATIONS)
      throw new Error("EVAL_REGRADE_TOO_LARGE");
    if (page.isDone) break;
    if (!page.cursor) throw new Error("Re-grade evidence cursor was missing");
    cursor = page.cursor;
  }

  const iterations: EvalRegradeIteration[] = [];
  const writes: RegradeWrite[] = [];
  for (const row of rows) {
    const outcome = regradeIteration(row, draft);
    const stored = {
      result: row.result,
      gradingRevision: row.gradingRevision ?? 0,
    };
    if (outcome.kind === "skipped") {
      iterations.push({
        iterationId: row.iterationId,
        caseId: row.caseId,
        outcome: "skipped",
        reason: outcome.reason,
        stored,
      });
      continue;
    }
    iterations.push({
      iterationId: row.iterationId,
      caseId: row.caseId,
      outcome: outcome.changed ? "regraded" : "unchanged",
      stored,
      regraded: {
        result: outcome.result,
        carriedChecks: outcome.carriedChecks,
      },
      flipped: outcome.result !== row.result,
    });
    if (outcome.changed)
      writes.push({
        iterationId: row.iterationId,
        expectedGradingRevision: row.gradingRevision ?? 0,
        expectedUpdatedAt: row.updatedAt,
        result: outcome.result,
        predicateResults: outcome.predicateResults,
      });
  }

  let applied: RegradeApplyResponse | undefined;
  if (!input.dryRun) {
    for (let start = 0; start < writes.length; start += REGRADE_WRITE_BATCH) {
      const batch = writes.slice(start, start + REGRADE_WRITE_BATCH);
      applied = await bounded(
        () =>
          input.applyBatch({
            runId: input.runId,
            draftHash,
            iterations: batch,
          }),
        deadline,
        input.signal,
      );
      const revisions = new Map(
        (applied.iterations ?? []).map((item) => [
          item.iterationId,
          item.gradingRevision,
        ]),
      );
      for (const item of iterations) {
        const revision = revisions.get(item.iterationId);
        if (revision !== undefined) item.gradingRevision = revision;
      }
    }
  }

  const count = (outcome: EvalRegradeIteration["outcome"]) =>
    iterations.filter((item) => item.outcome === outcome).length;
  return {
    schemaVersion: 1,
    runId: input.runId,
    suiteId: input.suiteId,
    draftHash,
    dryRun: input.dryRun,
    applied: applied !== undefined,
    counts: {
      iterations: iterations.length,
      regraded: count("regraded"),
      unchanged: count("unchanged"),
      skipped: count("skipped"),
      flipped: iterations.filter((item) => item.flipped).length,
    },
    iterations,
    ...(applied
      ? {
          run: {
            ...(applied.result !== undefined ? { result: applied.result } : {}),
            ...(applied.summary ? { summary: applied.summary } : {}),
            ...(applied.verdict ? { verdict: applied.verdict } : {}),
          },
        }
      : {}),
    modelUse: "none",
  };
}
