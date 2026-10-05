import { z } from "zod";
import { predicateSchema } from "../predicates/types.js";
import type { EvaluatorResult } from "./evaluator-types.js";

/** Explicit draft scope: replace all assertions, extend frozen ones, or inherit them. */
const backtestMatchOptionsSchema = z
  .object({
    toolCallOrder: z.enum(["ignore", "strict", "superset"]).optional(),
    argumentMatching: z.enum(["exact", "partial", "ignore"]).optional(),
    maxExtraToolCalls: z.number().int().nonnegative().nullable().optional(),
    allowExtraToolCalls: z.boolean().optional(),
  })
  .strict();
export const evalBacktestDraftSchema = z
  .object({
    matchOptions: backtestMatchOptionsSchema.nullable().optional(),
    assertions: z
      .object({
        mode: z.enum(["replace", "extend", "inherit"]),
        list: z.array(predicateSchema).max(25),
      })
      .strict(),
  })
  .strict();
export const evalBacktestContinuationSchema = z
  .object({
    cursor: z.string().min(1).max(8192),
    sourceHash: z.string().min(1).max(256),
    reservationId: z.string().min(1).max(256),
    draftHash: z.string().min(1).max(256),
  })
  .strict();
export const evalBacktestRequestSchema = evalBacktestDraftSchema.extend({
  continuation: evalBacktestContinuationSchema.optional(),
});
export type EvalBacktestContinuation = z.infer<
  typeof evalBacktestContinuationSchema
>;
export type EvalBacktestDraft = z.infer<typeof evalBacktestDraftSchema>;
export type EvalBacktestDifference = {
  iterationId: string;
  caseId: string;
  evaluatorId: string;
  change: "unchanged" | "configuration_changed" | "added" | "removed";
  comparable: boolean;
  reason?: string;
  stored?: EvaluatorResult;
  draft?: EvaluatorResult;
  flipped?: boolean;
};
export type EvalBacktestReport = {
  schemaVersion: 1;
  sourceRunId: string;
  sourceHash: string;
  draftHash: string;
  configRevision?: unknown;
  complete: boolean;
  continuationAvailable: boolean;
  continuation?: EvalBacktestContinuation;
  counts: {
    iterations: number;
    comparable: number;
    ungradable: number;
    flipped: number;
  };
  differences: EvalBacktestDifference[];
  modelUse: "none";
};

/**
 * Persisted re-grade of a completed run from its stored traces. The same
 * assertion draft as a backtest — replace, extend or inherit the frozen rules —
 * with no match-option changes (those change the matcher's recorded verdict,
 * which only a new run measures). `inherit` re-grades the frozen rules with
 * today's evaluators. `dryRun` returns the diff without persisting it.
 */
export const evalRegradeRequestSchema = z
  .object({
    assertions: evalBacktestDraftSchema.shape.assertions.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type EvalRegradeRequest = z.infer<typeof evalRegradeRequestSchema>;
export type EvalRegradeIteration = {
  iterationId: string;
  caseId: string;
  /**
   * `regraded` — the verdict or its check rows changed (persisted unless dry
   * run); `unchanged` — re-grading reproduced what is stored; `skipped` — the
   * stored evidence cannot re-grade this iteration (see `reason`) and it is
   * left exactly as recorded.
   */
  outcome: "regraded" | "unchanged" | "skipped";
  reason?: string;
  stored: { result: string; gradingRevision: number };
  regraded?: {
    result: "passed" | "failed";
    /** Checks the trace cannot evaluate, kept from the recorded rows. */
    carriedChecks: number;
  };
  flipped?: boolean;
  /** The iteration's revision after a persisted re-grade. */
  gradingRevision?: number;
};
export type EvalRegradeReport = {
  schemaVersion: 1;
  runId: string;
  suiteId: string;
  draftHash: string;
  dryRun: boolean;
  /** True when at least one re-graded verdict was written. */
  applied: boolean;
  counts: {
    iterations: number;
    regraded: number;
    unchanged: number;
    skipped: number;
    flipped: number;
  };
  iterations: EvalRegradeIteration[];
  /** The run as re-decided after the write; absent on a dry run or no-op. */
  run?: {
    result?: string;
    summary?: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    verdict?: string;
  };
  modelUse: "none";
};
