import { useSpineDrag } from "./spine-drag";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "@mcpjam/design-system/dropdown-menu";
import {
  CheckRow,
  type ToolArgSchemas,
} from "@/components/evals/checks-section";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
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
  toolArgSchemas,
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
  toolArgSchemas?: ToolArgSchemas;
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
          className={cn(
            "text-left text-[13px] font-semibold leading-[18px] text-card-foreground",
            canRole && onChangePredicate && "pr-56",
          )}
          aria-label={`Edit ${row.kindLabel}`}
          title={row.tooltip}
          onClick={onSelect}
        >
          {row.kindLabel}
        </button>
        {row.predicate?.type === "noToolErrors" ? (
          <p className="text-[13px] font-normal leading-[18px] text-card-foreground">
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
            toolArgSchemas={toolArgSchemas}
            readOnly={!editable}
          />
        ) : (
          <p className="text-[13px] font-normal leading-[18px] text-card-foreground">
            {row.label}
          </p>
        )}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-2">
        {row.stepId ? (
          <StatusDot status={overlayStatus(overlay, row.stepId)} />
        ) : null}
        {canRole && onChangePredicate ? (
          <div role="group" aria-label="If this check misses">
            <SegmentedControl<"required" | "advisory">
              value={row.role === "required" ? "required" : "advisory"}
              onChange={(role) =>
                onChangePredicate(withPredicateRole(row.predicate!, role))
              }
              options={[
                {
                  value: "required",
                  label: "Blocking",
                  disabled: !rolesForPredicateKind(
                    row.predicate!.type,
                  ).includes("required"),
                  title: rolesForPredicateKind(row.predicate!.type).includes(
                    "required",
                  )
                    ? "If this fails, the run fails and later steps are skipped."
                    : "This check can only warn.",
                },
                {
                  value: "advisory",
                  label: "Non-blocking",
                  title:
                    "If this fails, you get a warning. The run can still pass.",
                },
              ]}
            />
          </div>
        ) : !row.predicate ||
          [
            "noToolErrors",
            "finalAssistantMessageNonEmpty",
            "noEndingQuestion",
          ].includes(row.predicate.type) ||
          row.role === "advisory" ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-medium leading-[18px] text-secondary-foreground dark:text-muted-foreground">
            {row.role === "required" ? "Blocking" : "Non-blocking"}
          </span>
        ) : null}
        {!readOnly &&
        ((editable &&
          row.predicate?.type === "responseContains" &&
          onChangePredicate) ||
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
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {!readOnly && editable && onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            title={`Remove ${row.kindLabel}`}
            aria-label={`Remove ${row.kindLabel}`}
            className="flex size-6 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
