/**
 * Whether an imported case may run locally, and the approvals that let it.
 *
 * The hosted launch gate's rules (`mcpjam-backend`
 * `convex/lib/evalImportEligibility.ts#assertImportRunEligibility`), applied
 * to a local run — enforced here independently of any CLI flag parsing:
 *
 *   - a native case (no `import` block) and a claimed-`exact` case need no
 *     approval, and refuse one;
 *   - an `approximated` case runs only with a run-scoped, case-specific,
 *     non-blank reason of at most 500 characters;
 *   - `unsupported` and `unresolved` never run — there is nothing faithful to
 *     approve;
 *   - an approval naming an unknown, disabled, unselected or native case, a
 *     duplicate approval, and an approval nothing consumed are all refused
 *     rather than ignored;
 *   - an imported case's deterministic tool references must exist in the
 *     tools the servers actually expose (checked after discovery).
 *
 * The approval recorded is LOCAL evidence: it says this invocation carried a
 * reason, and claims no authenticated hosted actor.
 */

import { refusal, type SuiteFileRunProblem } from "./errors.js";
import type { ResolvedEvalSuiteFileCase } from "../suite-file-loader.js";
import type { SuiteFileImportApproval } from "./types.js";

export const MAX_IMPORT_APPROVAL_REASON_CHARS = 500;

export type ImportDecision =
  | { status: "claimed_exact" }
  | { status: "approved_approximation"; reason: string };

/**
 * Check every selected case's import claim and every approval, before
 * anything connects. Returns the decision per imported case.
 */
export function assertLocalImportEligibility(args: {
  cases: readonly ResolvedEvalSuiteFileCase[];
  selected: readonly ResolvedEvalSuiteFileCase[];
  approvals: readonly SuiteFileImportApproval[];
}): Map<string, ImportDecision> {
  const problems: SuiteFileRunProblem[] = [];
  const byId = new Map(args.cases.map((entry) => [entry.id, entry]));
  const selectedIds = new Set(args.selected.map((entry) => entry.id));
  const approvals = new Map<string, string>();

  for (const approval of args.approvals) {
    const caseId =
      typeof approval?.caseId === "string" ? approval.caseId.trim() : "";
    if (caseId === "") {
      problems.push({
        reason: "invalid_approval",
        message: "an approval names no case id.",
      });
      continue;
    }
    if (approvals.has(caseId)) {
      problems.push({
        caseId,
        reason: "duplicate_approval",
        message:
          "approved twice in one run. Send exactly one approval per approximated case.",
      });
      continue;
    }
    const reason =
      typeof approval.reason === "string" ? approval.reason.trim() : "";
    if (reason.length === 0) {
      problems.push({
        caseId,
        reason: "invalid_approval_reason",
        message:
          "the approval reason is blank — it is the record of WHY a lossy conversion was allowed to run.",
      });
      continue;
    }
    if (reason.length > MAX_IMPORT_APPROVAL_REASON_CHARS) {
      problems.push({
        caseId,
        reason: "invalid_approval_reason",
        message: `the approval reason must be at most ${MAX_IMPORT_APPROVAL_REASON_CHARS} characters (received ${reason.length}).`,
      });
      continue;
    }
    approvals.set(caseId, reason);
  }

  const decisions = new Map<string, ImportDecision>();
  const consumed = new Set<string>();
  for (const testCase of args.selected) {
    const claim = testCase.import;
    if (claim === undefined) continue;
    if (claim.status === "unsupported" || claim.status === "unresolved") {
      problems.push({
        caseId: testCase.id,
        reason:
          claim.status === "unsupported"
            ? "unsupported_case"
            : "unresolved_case",
        message:
          `was imported as "${claim.status}" and can never be executed. Remove it from ` +
          "this run, or re-import it once the converter can map it.",
      });
      continue;
    }
    if (claim.status === "exact") {
      if (approvals.has(testCase.id)) {
        consumed.add(testCase.id);
        problems.push({
          caseId: testCase.id,
          reason: "approval_not_required",
          message:
            'was imported as "exact" and needs no approval. Remove it — an approval on a ' +
            "case nobody had to approve is a receipt for a decision that never happened.",
        });
        continue;
      }
      decisions.set(testCase.id, { status: "claimed_exact" });
      continue;
    }
    const reason = approvals.get(testCase.id);
    if (reason === undefined) {
      problems.push({
        caseId: testCase.id,
        reason: "approval_required",
        message:
          'was imported as "approximated" — the converter recorded that it does NOT ' +
          "faithfully reproduce its source. Approve it for this run with a reason, or " +
          "exclude it; it will not execute unapproved.",
      });
      continue;
    }
    consumed.add(testCase.id);
    decisions.set(testCase.id, { status: "approved_approximation", reason });
  }

  for (const caseId of approvals.keys()) {
    if (consumed.has(caseId)) continue;
    const testCase = byId.get(caseId);
    if (!testCase) {
      problems.push({
        caseId,
        reason: "approval_case_unknown",
        message:
          "is not a case id declared by this suite file. Approvals name the AUTHORED id (cases[].id).",
      });
    } else if (testCase.disabled) {
      problems.push({
        caseId,
        reason: "approval_case_disabled",
        message:
          "is marked disabled, so this run will not execute it and the approval grants nothing.",
      });
    } else if (!selectedIds.has(caseId)) {
      problems.push({
        caseId,
        reason: "approval_case_not_selected",
        message:
          "is not among the cases this run executes, so the approval grants nothing.",
      });
    } else if (!testCase.import) {
      problems.push({
        caseId,
        reason: "approval_case_not_imported",
        message:
          'is not an imported case. Only an "approximated" import can be approved.',
      });
    }
    // Selected unsupported/unresolved cases were already refused above.
  }

  if (problems.length > 0) {
    throw refusal({
      code: "IMPORT_INELIGIBLE",
      phase: "validation",
      category: "import",
      summary:
        "Imported cases or approvals do not permit this run; nothing was run.",
      problems,
    });
  }
  return decisions;
}

/**
 * The tool names an imported case references deterministically, checked
 * against the tools discovered at launch. Exact matching only: a near-match
 * is precisely the drift this exists to catch.
 */
export function assertImportedToolReferences(args: {
  cases: ReadonlyArray<{
    caseId: string;
    imported: boolean;
    toolNames: readonly string[];
  }>;
  availableToolNames: ReadonlySet<string>;
}): void {
  const problems: SuiteFileRunProblem[] = [];
  for (const entry of args.cases) {
    if (!entry.imported) continue;
    for (const toolName of entry.toolNames) {
      if (args.availableToolNames.has(toolName)) continue;
      problems.push({
        caseId: entry.caseId,
        toolName,
        reason: "tool_not_in_snapshot",
        message:
          `is imported and expects tool "${toolName}", which the target servers do not ` +
          "expose. The mapping is unresolved against this environment; it will not be executed.",
      });
    }
  }
  if (problems.length > 0) {
    throw refusal({
      code: "IMPORT_INELIGIBLE",
      phase: "setup",
      category: "import",
      summary:
        "Imported cases reference tools the servers do not expose; nothing was run.",
      problems,
    });
  }
}
