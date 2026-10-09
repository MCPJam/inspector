import { useSpineDrag } from "./spine-drag";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@mcpjam/design-system/dropdown-menu";
import { CheckRow } from "@/components/evals/checks-section";
import { withPredicateRole } from "@/components/evals/suite-scorer-table-model";
import { rolesForPredicateKind } from "@/shared/predicate-kinds";
import type { Predicate } from "@/shared/eval-matching";
import type { ScorecardRow } from "../case-scorecard/case-scorecard-model";
import {
  StatusDot,
  overlayStatus,
  type SimpleCaseOverlay,
} from "../simple-case/status-dot";

/** Authoring row; shared field editors still own validation and serialization. */
export function PaperCheckRow({
  row,
  newest,
  readOnly,
  checkPolicy,
  availableTools,
  overlay,
  onChangePredicate,
  onRemove,
  onSelect,
  onOpenSuiteSettings,
  dragId,
}: {
  row: ScorecardRow;
  dragId?: string;
  newest?: boolean;
  readOnly: boolean;
  checkPolicy: boolean;
  availableTools?: string[];
  overlay?: SimpleCaseOverlay | null;
  onChangePredicate?: (next: Predicate) => void;
  onRemove?: () => void;
  onSelect?: () => void;
  onOpenSuiteSettings?: () => void;
}) {
  const editable = row.editable && !readOnly;
  const drag = useSpineDrag({
    id: dragId ?? row.key,
    phase: row.provenance === "step" ? "steps" : "case",
    kind: "assert",
    disabled: !editable,
  });
  const canRole =
    editable && checkPolicy && row.roleLock === "none" && row.predicate;
  return (
    <li
      {...drag.rowProps}
      data-testid="case-scorecard-row"
      data-row-key={row.key}
      data-provenance={row.provenance}
      data-role={row.role}
      data-step-id={row.stepId}
      data-newest={newest || undefined}
      className={cn(
        "relative min-w-0 bg-card py-2.5 pl-8 pr-11",
        newest &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary",
      )}
    >
      {drag.handle(row.kindLabel)}
      <div className="min-w-0 flex-1 space-y-1.5">
        <button
          type="button"
          className="text-left text-[13px] font-semibold leading-[18px] text-card-foreground"
          aria-label={`Edit ${row.kindLabel}`}
          title={row.tooltip}
          onClick={onSelect}
        >
          {row.kindLabel}
        </button>
        {row.predicate?.type === "noToolErrors" ? (
          <p className="text-[13px] leading-[18px] text-secondary-foreground dark:text-muted-foreground">
            Passes when no tool reports an error.
          </p>
        ) : row.predicate && onChangePredicate ? (
          <CheckRow
            noun="assertion"
            embedded
            paper
            predicate={row.predicate}
            onChange={onChangePredicate}
            availableTools={availableTools}
            readOnly={!editable}
          />
        ) : (
          <p className="text-[13px] leading-[18px] text-secondary-foreground dark:text-muted-foreground">
            {row.label}
          </p>
        )}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-2">
        {row.stepId ? (
          <StatusDot status={overlayStatus(overlay, row.stepId)} />
        ) : null}
        {!row.predicate ||
        [
          "noToolErrors",
          "finalAssistantMessageNonEmpty",
          "noEndingQuestion",
        ].includes(row.predicate.type) ||
        row.role === "advisory" ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-medium leading-[18px] text-secondary-foreground dark:text-muted-foreground">
            {row.role === "required" ? "Required" : "Advisory"}
          </span>
        ) : null}
        {!readOnly &&
        (onRemove ||
          canRole ||
          (onOpenSuiteSettings && row.provenance === "suite")) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={`Options for ${row.kindLabel}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canRole && onChangePredicate ? (
                <>
                  <DropdownMenuCheckboxItem
                    checked={row.role === "required"}
                    disabled={
                      !rolesForPredicateKind(row.predicate!.type).includes(
                        "required",
                      )
                    }
                    onSelect={() =>
                      onChangePredicate(
                        withPredicateRole(row.predicate!, "required"),
                      )
                    }
                    className="items-start"
                  >
                    <div>
                      <div className="text-xs font-medium">Required check</div>
                      <p className="text-[11px] text-muted-foreground">
                        {rolesForPredicateKind(row.predicate!.type).includes(
                          "required",
                        )
                          ? "A miss fails the task."
                          : "This check can only warn."}
                      </p>
                    </div>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={row.role === "advisory"}
                    onSelect={() =>
                      onChangePredicate(
                        withPredicateRole(row.predicate!, "advisory"),
                      )
                    }
                    className="items-start"
                  >
                    <div>
                      <div className="text-xs font-medium">Advisory check</div>
                      <p className="text-[11px] text-muted-foreground">
                        A miss warns. The task can still pass.
                      </p>
                    </div>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {editable &&
              row.predicate?.type === "responseContains" &&
              onChangePredicate ? (
                <DropdownMenuCheckboxItem
                  checked={row.predicate.caseSensitive ?? false}
                  onSelect={() =>
                    onChangePredicate({
                      ...(row.predicate as Extract<
                        Predicate,
                        { type: "responseContains" }
                      >),
                      caseSensitive: !(
                        row.predicate as Extract<
                          Predicate,
                          { type: "responseContains" }
                        >
                      ).caseSensitive,
                    })
                  }
                >
                  Case sensitive
                </DropdownMenuCheckboxItem>
              ) : null}
              {row.provenance === "suite" && onOpenSuiteSettings ? (
                <DropdownMenuItem onSelect={onOpenSuiteSettings}>
                  Edit in suite settings
                </DropdownMenuItem>
              ) : null}
              {editable && onRemove ? (
                <DropdownMenuItem onSelect={onRemove}>
                  Remove {row.kindLabel}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}
