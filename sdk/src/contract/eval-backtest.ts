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
