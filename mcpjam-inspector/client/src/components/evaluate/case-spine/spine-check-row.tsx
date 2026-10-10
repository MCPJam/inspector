import { useSpineDrag } from "./spine-drag";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@mcpjam/design-system/dropdown-menu";
import type { JoinedScorecardRow } from "../case-scorecard/trial-results";
import { TrialScorecardRow } from "../case-scorecard/trial-scorecard-row";
/**
 * One check, nested under the action it follows.
 *
 * A predicate check reuses `ScorecardRowView` verbatim — the same row the
 * trial pane renders, so the two panes cannot drift on a label, a role chip or
 * a provenance. A widget assertion needs its own row: `ScorecardRowView` only
 * expands when `row.predicate` is set, so on the old form a recorded
 * "View called a tool" check could be seen and deleted but never edited. It gets
 * the same chrome and the DOM-level fields underneath.
 */

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
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
  newest = false,
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
  newest?: boolean;
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
        newest={newest}
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
      paper={!readOnly}
      newest={newest}
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
  newest,
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
  newest: boolean;
}) {
  const [open, setOpen] = useState(!readOnly || defaultOpen);
  const editable = row.editable && !readOnly;
  const drag = useSpineDrag({
    id: `step:${step.id}`,
    phase: "steps",
    kind: "assert",
    disabled: !editable,
  });

  return (
    <li
      {...drag.rowProps}
      data-testid="case-scorecard-row"
      data-row-key={row.key}
      data-provenance="step"
      data-role={row.role}
      data-widget="yes"
      data-step-id={step.id}
      data-newest={newest || undefined}
      className={cn(
        "relative bg-card py-2.5 pl-8 pr-11",
        newest &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary",
      )}
    >
      <div className="flex items-center gap-2.5">
        {drag.handle(row.kindLabel)}
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Edit ${readOnly ? row.label : row.kindLabel}`}
          onClick={() => setOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={row.tooltip}
        >
          <span className="min-w-0 text-sm font-semibold leading-[18px] text-card-foreground">
            {readOnly ? row.label : row.kindLabel}
          </span>
        </button>
        <StatusDot status={status} />
        {/* A DOM assertion carries no check policy, so the chip states the
            role rather than offering one that cannot be written. */}
        {readOnly ? <RoleChip role={row.role} /> : null}
        {editable ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 size-7"
                aria-label={`Options for ${row.kindLabel}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onRemove}>
                Remove {row.kindLabel}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {open ? (
        <div className="mt-1.5">
          <fieldset disabled={readOnly} className="contents">
            <WidgetAssertionFields
              paper={!readOnly}
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
