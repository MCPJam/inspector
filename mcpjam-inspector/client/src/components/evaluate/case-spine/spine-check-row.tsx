import type { JoinedScorecardRow } from "../case-scorecard/trial-results";
import { TrialScorecardRow } from "../case-scorecard/trial-scorecard-row";
/**
 * One check, nested under the action it follows.
 *
 * A predicate check reuses `ScorecardRowView` verbatim — the same row the
 * trial pane renders, so the two panes cannot drift on a label, a role chip or
 * a provenance. A widget assertion needs its own row: `ScorecardRowView` only
 * expands when `row.predicate` is set, so on the old form a recorded
 * "View called tool" check could be seen and deleted but never edited. It gets
 * the same chrome and the DOM-level fields underneath.
 */

import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { AssertStep, WidgetAssertion } from "@/shared/steps";
import type { Predicate } from "@/shared/eval-matching";
import {
  WidgetAssertionFields,
  type AvailableTool,
} from "@/components/evals/step-fields";
import { RoleChip } from "@/components/evals/scorer-role-control";
import type { ScorecardRow } from "../case-scorecard/case-scorecard-model";
import { ScorecardRowView } from "../case-scorecard/scorecard-row";
import { ProvenanceChip } from "../case-scorecard/provenance-chip";
import { RowMarker } from "../case-scorecard/row-marker";
import { StatusDot } from "../simple-case/status-dot";

export function SpineCheckRow({
  step,
  row,
  trialRow,
  availableTools,
  readOnly,
  checkPolicy,
  status,
  defaultOpen,
  onChange,
  onRemove,
  onSelect,
}: {
  trialRow?: JoinedScorecardRow;
  step: AssertStep;
  /** The row `buildCaseScorecard` produced for this step, when it made one. */
  row: ScorecardRow | undefined;
  availableTools: AvailableTool[];
  readOnly: boolean;
  checkPolicy: boolean;
  status: EvalStepStatus | undefined;
  defaultOpen: boolean;
  onChange: (next: AssertStep) => void;
  onRemove: () => void;
  onSelect?: () => void;
}) {
  if (!row) return null;
  if (trialRow) return <TrialScorecardRow row={trialRow} />;
  // `ScorecardRowView` reads its status through the overlay map, so synthesize
  // one from the status the spine already resolved rather than passing two
  // sources of truth down.
  const overlay = status
    ? { stepStatusById: new Map([[step.id, status]]) }
    : null;

  if (row.widgetAssertion) {
    return (
      <WidgetCheckRow
        step={step}
        row={row}
        assertion={row.widgetAssertion}
        availableTools={availableTools}
        readOnly={readOnly}
        status={status}
        defaultOpen={defaultOpen}
        onChange={onChange}
        onRemove={onRemove}
      />
    );
  }

  return (
    <ScorecardRowView
      row={row}
      availableTools={availableTools.map((tool) => tool.name)}
      readOnly={readOnly}
      checkPolicy={checkPolicy}
      overlay={overlay}
      defaultOpen={defaultOpen}
      onChangePredicate={(next: Predicate) =>
        onChange({ ...step, assertion: next })
      }
      onRemove={onRemove}
      onSelect={onSelect}
    />
  );
}

function WidgetCheckRow({
  step,
  row,
  assertion,
  availableTools,
  readOnly,
  status,
  defaultOpen,
  onChange,
  onRemove,
}: {
  step: AssertStep;
  row: ScorecardRow;
  assertion: WidgetAssertion;
  availableTools: AvailableTool[];
  readOnly: boolean;
  status: EvalStepStatus | undefined;
  defaultOpen: boolean;
  onChange: (next: AssertStep) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const editable = row.editable && !readOnly;

  return (
    <li
      data-testid="case-scorecard-row"
      data-row-key={row.key}
      data-provenance="step"
      data-role={row.role}
      data-widget="yes"
      data-step-id={step.id}
      className="rounded-md border border-border/60 bg-background/40"
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <RowMarker row={row} />
        <ProvenanceChip provenance="step" />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Edit ${row.label}`}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={row.tooltip}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate text-xs text-foreground">
            {row.label}
          </span>
        </button>
        <StatusDot status={status} />
        {/* A DOM assertion carries no check policy, so the chip states the
            role rather than offering one that cannot be written. */}
        <RoleChip role={row.role} />
        {editable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
            aria-label={`Remove ${row.label}`}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-border/60 px-2.5 py-2">
          <fieldset disabled={readOnly} className="contents">
            <WidgetAssertionFields
              value={assertion}
              onChange={(next) => onChange({ ...step, assertion: next })}
              availableTools={availableTools}
              readOnly={readOnly}
            />
          </fieldset>
        </div>
      ) : null}
    </li>
  );
}
