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

/**
 * What the authoring model was unsure about, as one clause, or `undefined`
 * when it was sure.
 *
 * Distinct from {@link authoredCaseBlockedReason}, which is a refusal: the
 * case cannot run at all. This is a DOUBT. The case is runnable and a person
 * should read it first, so neither surface saves it without one.
 *
 * Lives here because both surfaces have to answer it the same way. The app
 * keeps a flagged draft out of "Add all" and offers "Save anyway"; the API has
 * nobody to ask, so it leaves the case in `skipped` with the review link. When
 * the app's rule lived only in the client, the API had no rule at all and
 * silently saved cases the app would have held back.
 *
 * Returns a CLAUSE, not a sentence: each caller adds the instruction that fits
 * it ("Read the steps above before you save." in the app, the review link in
 * an API response), and neither tells a reader to look somewhere they are not.
 */
export function authoringDraftCheckReason(
  draft: Pick<EvalAuthoringDraft, "issues" | "source">
): string | undefined {
  // An issue a person has already answered in writing is settled.
  const issues = draft.issues.filter((issue) => !issue.resolution);
  if (!issues.length) return undefined;
  const codes = new Set(issues.map((issue) => issue.code));
  // A generated case has no document, so the imported wording ("Your document
  // names tools this server does not have") described a file the reader never
  // supplied, on the one surface where they could not go and look at it.
  const imported = Boolean(draft.source);
  const clauses: string[] = [];
  if (codes.has("unknown_tool"))
    clauses.push("names tools this server does not have");
  if (codes.has("invalid_arguments"))
    clauses.push("calls a tool with arguments it does not take");
  if (codes.has("unsupported_workflow"))
    clauses.push("asks for something this server cannot do");
  if (codes.has("missing_prerequisite"))
    clauses.push("skips a step the case depends on");
  if (codes.has("missing_evidence"))
    clauses.push(
      imported
        ? "cites something the document does not show"
        : "uses a value your server never returned"
    );
  const subject = clauses.length
    ? `${imported ? "Your document" : "This case"} ${clauses.join(", and ")}`
    : undefined;
  const outcome =
    codes.has("missing_expectation") || codes.has("unclear_expectation")
      ? "nothing here checks the outcome"
      : undefined;
  return (
    [subject, outcome].filter(Boolean).join(", and ") ||
    "MCPJam was unsure about this case"
  );
}

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
