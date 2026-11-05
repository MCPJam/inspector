/**
 * Small projections the steps editor and its preview share.
 *
 * Every assertion the editor nests under a step gets one collapsible row. The
 * scorecard already builds a row for each step assertion except a required
 * "Tool was called with", which it files under the route instead; the editor
 * shows that one under its step like any other, so it builds the row here.
 */

import type { AssertStep, TestStep } from "@/shared/steps";
import { isWidgetAssertion, WIDGET_ASSERTION_LABELS } from "@/shared/steps";
import { roleOfPredicate } from "@/components/evals/suite-scorer-table-model";
import {
  scorerKindLabel,
  scorerRowLabel,
  stageOfPredicate,
  type CaseScorecard,
  type ScorecardRow,
} from "../case-scorecard/case-scorecard-model";
import type {
  EditorAnchor,
  ExecutionPreviewItem,
  PreviewEndOfRun,
} from "./case-steps-model";

export function stepAssertionRows(
  card: CaseScorecard,
  steps: TestStep[],
): Map<string, ScorecardRow> {
  const rows = new Map<string, ScorecardRow>();
  for (const row of card.groups.flatMap((group) => group.rows)) {
    if (row.stepId) rows.set(row.stepId, row);
  }
  for (const step of steps) {
    if (step.kind !== "assert" || rows.has(step.id)) continue;
    const row = toolAssertionRow(step);
    if (row) rows.set(step.id, row);
  }
  return rows;
}

function toolAssertionRow(step: AssertStep): ScorecardRow | null {
  const predicate = step.assertion;
  if (isWidgetAssertion(predicate) || predicate.type !== "toolCalledWith") {
    return null;
  }
  const role = roleOfPredicate(predicate);
  const kindLabel = scorerKindLabel(predicate);
  return {
    key: `step:${step.id}`,
    stage: stageOfPredicate(predicate),
    provenance: "step",
    label: scorerRowLabel(predicate, "step"),
    kindLabel,
    role,
    roleLock: "none",
    editable: true,
    stepId: step.id,
    predicate,
    tooltip: kindLabel,
  };
}

/** The preview's last item, which holds every whole-run assertion. */
export function endOfRunOf(items: ExecutionPreviewItem[]): PreviewEndOfRun {
  for (const item of items) if (item.kind === "endOfRun") return item;
  throw new Error("The execution preview has no end-of-run item.");
}

/** One line naming an assertion, for the preview. */
export function assertionSummary(step: AssertStep): string {
  const assertion = step.assertion;
  if (!isWidgetAssertion(assertion) && assertion.type === "toolCalledWith") {
    return `Tool was called with “${assertion.toolName || "…"}”`;
  }
  if (!isWidgetAssertion(assertion)) {
    return scorerRowLabel(assertion, "step");
  }
  return WIDGET_ASSERTION_LABELS[assertion.kind] ?? assertion.kind;
}

// ── anchors ──────────────────────────────────────────────────────────────────

/** The element attribute an editor block carries its anchor in. */
export const ANCHOR_ATTRIBUTE = "data-editor-anchor";

/** The search param a link uses to open the editor at one step. */
export const STEP_PARAM = "step";

/** A 1C anchor (`step:abc`, `outcome`…), or null for anything else. */
export function parseEditorAnchor(value: string | null): EditorAnchor | null {
  if (!value) return null;
  if (value === "outcome" || value === "after-run") return value;
  if (/^(step|assertion):.+/.test(value)) return value as EditorAnchor;
  return null;
}

/** The anchor `?step=` names in an address's search string. */
export function anchorFromSearch(search: string): EditorAnchor | null {
  return parseEditorAnchor(new URLSearchParams(search).get(STEP_PARAM));
}

export function anchorSearch(anchor: EditorAnchor): string {
  return `?${new URLSearchParams({ [STEP_PARAM]: anchor })}`;
}

/** Scrolls the editor to an anchor and moves focus there. */
export function revealAnchor(root: ParentNode, anchor: EditorAnchor): boolean {
  const target = root.querySelector<HTMLElement>(
    `[${ANCHOR_ATTRIBUTE}="${CSS.escape(anchor)}"]`,
  );
  if (!target) return false;
  target.scrollIntoView?.({ block: "center", behavior: "smooth" });
  target.focus({ preventScroll: true });
  return true;
}
