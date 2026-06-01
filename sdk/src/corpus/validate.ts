/**
 * Corpus validation: structural shape, predicate shape, review status, and
 * provenance, plus the gate-eligibility rule.
 *
 * The single load-bearing invariant: **only `human_reviewed` cases may be used
 * as CI gates.** `llm_draft` cases are a review queue. `validateCorpusCase`
 * also enforces that a `human_reviewed` case carries reviewer metadata and a
 * non-empty predicate set, that trace-derived cases are privacy-reviewed and
 * have a reconstructable tool inventory, and that ToolBench cases cite their
 * source — so a draft cannot be promoted to a gate while missing the metadata
 * a human needs to audit it.
 */

import { z } from "zod";
import type { CorpusCase } from "./types.js";

/** Argument matcher (mirrors `predicates/types.ts` `ArgMatcher`). */
const argMatcherSchema = z
  .object({
    args: z.record(z.string(), z.unknown()),
    argumentMatching: z.enum(["exact", "partial", "ignore"]).optional(),
  })
  .strict();

const toolCallSchema = z
  .object({
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * Zod mirror of the {@link import("../predicates/types.js").Predicate} union.
 * Kept in lockstep with `predicates/types.ts`; a new predicate type must be
 * added here too or corpus validation will reject it. `.strict()` on each
 * member rejects malformed/extra fields.
 */
export const predicateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("toolCalledWith"),
      toolName: z.string().min(1),
      args: argMatcherSchema,
      minCount: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("toolCalledAtLeastOnce"), toolName: z.string().min(1) })
    .strict(),
  z
    .object({ type: z.literal("toolNeverCalled"), toolName: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("responseContains"),
      needle: z.string().min(1),
      caseSensitive: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("responseMatches"),
      pattern: z
        .string()
        .min(1)
        .refine(
          (s) => {
            try {
              new RegExp(s);
              return true;
            } catch {
              return false;
            }
          },
          { message: "must be a valid regular expression" },
        ),
    })
    .strict(),
  z.object({ type: z.literal("noToolErrors") }).strict(),
  z.object({ type: z.literal("finalAssistantMessageNonEmpty") }).strict(),
  z
    .object({ type: z.literal("tokenBudgetUnder"), tokens: z.number().int().positive() })
    .strict(),
]);

const privacyReviewSchema = z
  .object({
    reviewed: z.boolean(),
    reviewedBy: z.string().optional(),
    reviewedAt: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

const traceProvenanceSchema = z
  .object({
    source: z.literal("trace"),
    draftingModel: z.string().min(1),
    reviewedBy: z.string().optional(),
    reviewedAt: z.string().optional(),
    traceId: z.string().min(1),
    chatSessionId: z.string().min(1),
    promptIndex: z.number().int().nonnegative(),
    modelId: z.string().optional(),
    hostConfigId: z.string().min(1),
    toolSnapshotHashAtTurn: z.string().optional(),
    manualToolInventoryNote: z.string().optional(),
    spanSummary: z.string().optional(),
    privacyReview: privacyReviewSchema,
  })
  .strict();

const toolbenchProvenanceSchema = z
  .object({
    source: z.literal("toolbench"),
    draftingModel: z.string().min(1),
    reviewedBy: z.string().optional(),
    reviewedAt: z.string().optional(),
    toolbenchSnapshotKey: z.string().min(1),
    toolbenchId: z.string().min(1),
    originalIssueIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const provenanceSchema = z.discriminatedUnion("source", [
  traceProvenanceSchema,
  toolbenchProvenanceSchema,
]);

const corpusCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    server: z.string().min(1),
    query: z.string().min(1),
    expectedToolCalls: z.array(toolCallSchema),
    successPredicates: z.array(predicateSchema),
    reviewStatus: z.enum(["llm_draft", "human_reviewed"]),
    provenance: provenanceSchema,
    category: z
      .enum([
        "read-only",
        "single-mutation",
        "multi-step",
        "error-recovery",
        "large-output",
      ])
      .optional(),
    notes: z.string().optional(),
  })
  .strict();

export type ValidationResult<T> =
  | { ok: true; value: T; errors: [] }
  | { ok: false; value?: T; errors: string[] };

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/** Validate a single predicate's shape. Unknown type / malformed fields fail. */
export function validatePredicate(raw: unknown): ValidationResult<unknown> {
  const parsed = predicateSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data, errors: [] }
    : { ok: false, errors: formatIssues(parsed.error) };
}

/**
 * Cross-field rules that the structural schema cannot express. Run only after
 * a successful structural parse; receives the typed case.
 */
function semanticErrors(c: CorpusCase): string[] {
  const errors: string[] = [];

  if (c.reviewStatus === "human_reviewed") {
    // Reviewer attribution AND timestamp — a gate-eligible case must be fully
    // auditable (who promoted it, when).
    if (!c.provenance.reviewedBy) {
      errors.push(
        "provenance.reviewedBy: required when reviewStatus is 'human_reviewed'",
      );
    }
    if (!c.provenance.reviewedAt) {
      errors.push(
        "provenance.reviewedAt: required when reviewStatus is 'human_reviewed'",
      );
    }
    if (c.successPredicates.length === 0) {
      errors.push(
        "successPredicates: a 'human_reviewed' case must have at least one predicate",
      );
    }
  }

  if (c.provenance.source === "trace") {
    const p = c.provenance;
    if (!p.toolSnapshotHashAtTurn && !p.manualToolInventoryNote) {
      errors.push(
        "provenance: trace cases require either 'toolSnapshotHashAtTurn' or a 'manualToolInventoryNote'",
      );
    }
    if (c.reviewStatus === "human_reviewed" && !p.privacyReview.reviewed) {
      errors.push(
        "provenance.privacyReview.reviewed: must be true to promote a trace case to 'human_reviewed'",
      );
    }
    // A completed privacy review must name its reviewer and time — otherwise
    // `reviewed: true` is an unauditable assertion.
    if (p.privacyReview.reviewed) {
      if (!p.privacyReview.reviewedBy) {
        errors.push(
          "provenance.privacyReview.reviewedBy: required when privacyReview.reviewed is true",
        );
      }
      if (!p.privacyReview.reviewedAt) {
        errors.push(
          "provenance.privacyReview.reviewedAt: required when privacyReview.reviewed is true",
        );
      }
    }
  }

  return errors;
}

/** Validate a corpus case end to end (structure + predicate shape + semantics). */
export function validateCorpusCase(raw: unknown): ValidationResult<CorpusCase> {
  const parsed = corpusCaseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  const value = parsed.data as CorpusCase;
  const errors = semanticErrors(value);
  return errors.length === 0
    ? { ok: true, value, errors: [] }
    : { ok: false, value, errors };
}

/**
 * Gate eligibility: a case may be used with `--gate` iff it validates cleanly
 * AND is `human_reviewed`. (A valid `human_reviewed` case is guaranteed to have
 * a non-empty predicate set by {@link semanticErrors}.)
 */
export function isGateEligible(raw: unknown): boolean {
  const result = validateCorpusCase(raw);
  return result.ok && result.value.reviewStatus === "human_reviewed";
}

/** Validate a suite (array of cases); returns per-index results plus a roll-up. */
export function validateSuite(raw: unknown): {
  ok: boolean;
  cases: Array<ValidationResult<CorpusCase>>;
  gateEligible: CorpusCase[];
} {
  const list = Array.isArray(raw) ? raw : [raw];
  const cases = list.map((c) => validateCorpusCase(c));
  const gateEligible = cases
    .filter((r): r is { ok: true; value: CorpusCase; errors: [] } => r.ok)
    .map((r) => r.value)
    .filter((c) => c.reviewStatus === "human_reviewed");
  return { ok: cases.every((r) => r.ok), cases, gateEligible };
}
