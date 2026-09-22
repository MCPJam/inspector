import { z } from "zod";
import { stepsSchema } from "./steps.js";
import { caseSourceSchema } from "./case-source.js";

export const EVAL_AUTHORING_VERSION = 1;
export const authoringIssueSchema = z
  .object({
    code: z.enum([
      "missing_expectation",
      "missing_prerequisite",
      "unclear_expectation",
      "unsupported_workflow",
      "unknown_tool",
      "invalid_arguments",
      "missing_evidence",
    ]),
    message: z.string().min(1).max(2000),
    stepId: z.string().optional(),
    blocking: z.boolean().default(true),
    origin: z.enum(["model", "validation"]).optional(),
    resolution: z.string().trim().min(10).max(2000).optional(),
  })
  .strict();
export const authoringAdditionSchema = z
  .object({
    id: z.string().min(1).max(200),
    path: z.string().min(1).max(500),
    explanation: z.string().min(1).max(2000),
  })
  .strict();

/** The persisted case contract, not a model-specific prompt/turn projection. */
export const authoredEvalCaseSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    steps: stepsSchema,
    expectedOutput: z.string().max(10000).optional(),
    isNegativeTest: z.boolean().default(false),
    runs: z.number().int().min(1).max(10).default(5),
    models: z
      .array(
        z
          .object({ model: z.string().min(1), provider: z.string().min(1) })
          .strict()
      )
      .max(20)
      .default([]),
    scenario: z.string().max(10000).optional(),
    checks: z
      .object({
        mode: z.enum(["inherit", "replace", "extend"]),
        list: z.array(z.record(z.string(), z.unknown())).max(200),
      })
      .strict()
      .optional(),
    matchOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AuthoredEvalCase = z.infer<typeof authoredEvalCaseSchema>;
export const evalAuthoringDraftSchema = z
  .object({
    version: z.literal(EVAL_AUTHORING_VERSION),
    draftId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    case: authoredEvalCaseSchema,
    source: caseSourceSchema.optional(),
    issues: z.array(authoringIssueSchema).max(100),
    evidenceNotes: z
      .array(z.string().trim().min(10).max(2000))
      .max(100)
      .optional(),
    additions: z.array(authoringAdditionSchema).max(200),
    review: z.enum(["required", "accepted"]),
  })
  .strict();
export type EvalAuthoringDraft = z.infer<typeof evalAuthoringDraftSchema>;

/** Semantic checks shared by editors; the write boundary repeats them. */
export function authoredCaseBlockedReason(
  input: AuthoredEvalCase
): string | undefined {
  if (!input.title.trim()) return "Add a case title.";
  if (!input.steps.length) return "Add at least one step.";
  if (new Set(input.steps.map((step) => step.id)).size !== input.steps.length)
    return "Step ids must be unique.";
  if (input.steps.some((step) => step.kind === "prompt" && !step.prompt.trim()))
    return "Complete each prompt step.";
  if (input.isNegativeTest) {
    if (
      input.steps.some(
        (step) =>
          step.kind === "assert" &&
          "type" in step.assertion &&
          step.assertion.type === "toolCalledWith"
      )
    )
      return "Negative cases cannot require tool calls.";
    return undefined;
  }
  if (
    !input.steps.some((step) => step.kind === "assert") &&
    !input.expectedOutput?.trim() &&
    !input.checks?.list.length
  )
    return "Add an assertion, expected outcome, or case check.";
  return undefined;
}
