import type { EvalAuthoringDraft } from "./eval-authoring.js";

/**
 * What the authoring model was unsure about, as one clause, or `undefined`
 * when it was sure.
 *
 * Distinct from `authoredCaseBlockedReason`, which is a refusal: the case
 * cannot run at all. This is a DOUBT. The case is runnable and a person
 * should read it first, so neither surface saves it without one.
 *
 * Shared because both inspector surfaces have to answer it the same way. The
 * app keeps a flagged draft out of "Add all" and offers "Save anyway"; the API
 * has nobody to ask, so it leaves the case in `skipped` with the review link.
 * When the app's rule lived only in the client, the API had no rule at all and
 * silently saved cases the app would have held back.
 *
 * NOT in `eval-authoring.ts`, on purpose. That file is mirrored token for token
 * into the backend (`convex/lib/evalAuthoring.ts`, checked by
 * `scripts/check-authoring-mirror.mjs`) because both repos enforce it. This
 * rule is inspector-only: the backend never decides what to hold back, it
 * only records the issues. Putting it in the mirrored file would force a copy
 * of dead code into the backend just to keep the two files equal.
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
