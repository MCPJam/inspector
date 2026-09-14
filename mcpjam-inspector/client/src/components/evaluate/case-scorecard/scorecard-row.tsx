/**
 * One scorer, on one line.
 *
 * The old form gave every check a card with its own heading and an explanatory
 * sentence, so four checks filled a screen and the shape of the grading was
 * invisible. A row is: what it checks, who wrote it, what a miss does, and a
 * way in. The sentence moves to the label's tooltip and the expanded body,
 * which is where a reader goes when they actually want it.
 */

import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { Predicate } from "@/shared/eval-matching";
import { CheckRow } from "@/components/evals/checks-section";
import {
  RoleChip,
  RoleSegmentGroup,
} from "@/components/evals/scorer-role-control";
import { withPredicateRole } from "@/components/evals/suite-scorer-table-model";
import { rolesForPredicateKind } from "@/shared/predicate-kinds";
import { StatusDot, type SimpleCaseOverlay, overlayStatus } from "../simple-case/status-dot";
import { ProvenanceChip } from "./provenance-chip";
import { RowMarker } from "./row-marker";
import type { ScorecardRow } from "./case-scorecard-model";

export function ScorecardRowView({
  row,
  availableTools,
  readOnly,
  checkPolicy,
  overlay,
  defaultOpen = false,
  onChangePredicate,
  onRemove,
  onSelect,
  onOpenSuiteSettings,
}: {
  row: ScorecardRow;
  availableTools?: string[];
  readOnly: boolean;
  /**
   * Whether the backend accepts a role on a check. Absent, loading and
   * unavailable all behave the same as `false` — the control disappears, the
   * chip stays, and the page is exactly what it was before roles shipped.
   */
  checkPolicy: boolean;
  overlay?: SimpleCaseOverlay | null;
  defaultOpen?: boolean;
  onChangePredicate?: (next: Predicate) => void;
  onRemove?: () => void;
  onSelect?: () => void;
  onOpenSuiteSettings?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const editable = row.editable && !readOnly;
  const canEditFields = editable && Boolean(onChangePredicate) && row.predicate;
  const canRole = editable && checkPolicy && row.roleLock === "none" && row.predicate;

  return (
    <li
      data-testid="case-scorecard-row"
      data-row-key={row.key}
      data-provenance={row.provenance}
      data-role={row.role}
      {...(row.stepId ? { "data-step-id": row.stepId } : {})}
      className={cn(
        "rounded-md border border-border/60 bg-background/40",
        row.provenance === "suite" && "bg-muted/20",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <RowMarker row={row} />
        <ProvenanceChip provenance={row.provenance} />
        {canEditFields ? (
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
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs text-foreground"
            title={row.tooltip}
            onClick={onSelect}
          >
            {row.label}
          </span>
        )}

        {row.stepId ? <StatusDot status={overlayStatus(overlay, row.stepId)} /> : null}

        {canRole && onChangePredicate ? (
          <RoleSegmentGroup
            value={row.role}
            // An observation is a heuristic, so it is offered as Warn or
            // Report and never as a Gate — the same rule the Zod schema
            // enforces at the save, and the same restriction the suite table
            // applies. Offering a Gate the save is going to refuse is a
            // control that lies.
            roles={rolesForPredicateKind(row.predicate!.type)}
            ariaLabel={`Role for ${row.label}`}
            onChange={(role) =>
              onChangePredicate(withPredicateRole(row.predicate!, role))
            }
          />
        ) : (
          <RoleChip role={row.role} />
        )}

        {row.provenance === "suite" && onOpenSuiteSettings ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground"
            onClick={onOpenSuiteSettings}
          >
            Edit in suite settings
          </Button>
        ) : null}

        {editable && onRemove ? (
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

      {open && canEditFields && row.predicate && onChangePredicate ? (
        <div className="border-t border-border/50 px-2.5 py-2">
          <CheckRow
            noun="assertion"
            embedded
            predicate={row.predicate}
            onChange={onChangePredicate}
            availableTools={availableTools}
            readOnly={readOnly}
          />
        </div>
      ) : null}
    </li>
  );
}
