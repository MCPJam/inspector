/**
 * The zod mirror of {@link EvaluatorResult}.
 *
 * ── Why it validates by delegation ───────────────────────────────────────────
 *
 * The interesting half of a result schema is not its field types; it is the
 * three cross-field rules: `passed` must equal `score >= passThreshold`, a
 * non-scored row may carry neither, and only an errored row may carry `error`.
 * Those rules are what make a tampered score set unrepresentable rather than
 * merely unusual, and re-typing them here would create a second implementation
 * of them — with a way to disagree with the first, on exactly the payload where
 * disagreement turns a failing run into a passing one.
 *
 * So the structural half is declared here, and the rules are checked by
 * projecting the row onto the score contract and running the schema that
 * already owns them. Issue paths are renamed on the way back out, so a caller
 * gets `score` and `explanation` in the error it reads rather than the field
 * names of a shape it never sent.
 */

import { z } from "zod";
import { predicateScopeSchema } from "../predicates/types.js";
import { scoreResultSchema } from "./schemas.js";
import { fromEvaluatorResult } from "./evaluator-derive.js";
import {
  EVALUATOR_KINDS,
  EVALUATOR_RESULT_SCHEMA_VERSION,
} from "./evaluator-types.js";
import {
  MAX_ERROR_LENGTH,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_SCORER_ID_LENGTH,
} from "./types.js";

export const evaluatorKindSchema = z.enum(EVALUATOR_KINDS);

export const evaluatorStatusSchema = z.enum([
  "scored",
  "error",
  "skipped",
  "not_applicable",
]);

const unitIntervalSchema = z.number().min(0).max(1);

/** The field names an issue path carries in the canonical shape. */
const PATH_RENAMES: Record<string, string> = {
  scorerId: "evaluatorId",
  scorerVersion: "evaluatorVersion",
  value: "score",
  rationale: "explanation",
};

const evaluatorResultStructuralSchema = z
  .object({
    schemaVersion: z.literal(EVALUATOR_RESULT_SCHEMA_VERSION),
    evaluatorId: z.string().min(1).max(MAX_SCORER_ID_LENGTH),
    evaluatorVersion: z.string().min(1),
    definitionHash: z.string().min(1),
    kind: evaluatorKindSchema,
    status: evaluatorStatusSchema,
    score: unitIntervalSchema.optional(),
    passThreshold: unitIntervalSchema,
    passed: z.boolean().optional(),
    explanation: z.string().max(MAX_RATIONALE_LENGTH).optional(),
    evidence: z
      .array(z.string().max(MAX_EVIDENCE_ENTRY_LENGTH))
      .max(MAX_EVIDENCE_ENTRIES)
      .optional(),
    deterministic: z.boolean(),
    model: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
    error: z.string().min(1).max(MAX_ERROR_LENGTH).optional(),
    scope: predicateScopeSchema.optional(),
  })
  .strict();

export const evaluatorResultSchema = evaluatorResultStructuralSchema.superRefine(
  (row, ctx) => {
    // `kind` is derived, so a row asserting one that contradicts its own
    // `deterministic` is not a row anybody produced — it is a hand-edited or
    // re-serialized payload, and letting it through would put a judge's score
    // under an assertion's heading on every surface that groups by kind.
    const derivedKind = row.deterministic ? "assertion" : "judge";
    if (row.kind !== derivedKind) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message:
          `\`kind\` is derived from \`deterministic\` ` +
          `(${row.deterministic} means "${derivedKind}", got "${row.kind}")`,
      });
    }

    const parsed = scoreResultSchema.safeParse(fromEvaluatorResult(row));
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path.map((segment) =>
          typeof segment === "string" ? (PATH_RENAMES[segment] ?? segment) : segment
        ),
        // Word boundaries, not backticked whole names: the derivation failure
        // embeds the field inside an expression (``passed` must equal `value >=
        // passThreshold``), and a caller that sent `score` should never be told
        // about a field it has never seen in a shape it never used.
        message: Object.entries(PATH_RENAMES).reduce(
          (message, [from, to]) =>
            message.replace(new RegExp(`\\b${from}\\b`, "g"), to),
          issue.message
        ),
      });
    }
  }
);

export const evaluatorResultArraySchema = z.array(evaluatorResultSchema);
