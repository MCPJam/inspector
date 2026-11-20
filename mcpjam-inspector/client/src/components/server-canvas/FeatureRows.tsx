import type { MouseEvent } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { FeatureAssessment } from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";
import { FeatureCountsText } from "./FeatureCounts";
import {
  FEATURE_STATE_META,
  MARKER_LABELS,
  SOURCE_LABELS,
  rowStateLabels,
} from "./feature-states";
import type { FamilyModel, FeatureRowModel } from "./feature-tree";

/** Selects what the list view's arrow keys move focus between. */
export const FEATURE_NAV_SELECTOR = "[data-feature-nav]";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The run behind a failed check, if the evidence names one. */
export function failedRunId(assessment: FeatureAssessment): string | undefined {
  return assessment.evidence.find(
    (entry) => entry.outcome === "failed" && entry.ref?.runId,
  )?.ref?.runId;
}

function rowLabel({ feature, assessment, needsNewer }: FeatureRowModel): string {
  const source = assessment.sources[0];
  const parts = [feature.name, rowStateLabels(assessment.state, needsNewer).label];
  if (assessment.state === "supported" && source)
    parts.push(SOURCE_LABELS[source]);
  for (const marker of assessment.markers) parts.push(MARKER_LABELS[marker]);
  return parts.join(", ");
}

/** Buttons inside a canvas node must not also select the node. */
function stop(handler: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

export function FeatureRow({
  row,
  selected,
  onSelect,
  onOpenRun,
}: {
  row: FeatureRowModel;
  selected: boolean;
  onSelect: (featureId: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const { feature, assessment, depth } = row;
  const meta = FEATURE_STATE_META[assessment.state];
  const { shortLabel } = rowStateLabels(assessment.state, row.needsNewer);
  const Icon = meta.icon;
  const source = assessment.sources[0];
  const runId =
    assessment.state === "check-failed" ? failedRunId(assessment) : undefined;
  return (
    <li
      data-state={assessment.state}
      className={cn(
        "flex items-center gap-1 rounded-md",
        meta.rowClass,
        selected && "ring-2 ring-primary/60",
      )}
      style={{ paddingLeft: depth * 14 }}
    >
      <button
        type="button"
        data-feature-nav=""
        aria-label={rowLabel(row)}
        aria-current={selected ? "true" : undefined}
        onClick={stop(() => onSelect(feature.id))}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-foreground/5",
          focusRing,
        )}
      >
        <Icon aria-hidden className={cn("size-3.5 shrink-0", meta.iconClass)} />
        <span className="min-w-0 flex-1 truncate" title={feature.name}>
          {feature.name}
        </span>
        {assessment.markers.map((marker) => (
          <span
            key={marker}
            className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground"
          >
            {MARKER_LABELS[marker]}
          </span>
        ))}
        {assessment.state === "supported" && source ? (
          <span className="shrink-0 rounded-full border border-border bg-background px-1.5 text-[10.5px] text-muted-foreground">
            {SOURCE_LABELS[source]}
          </span>
        ) : (
          <span className="shrink-0 text-[11px]">
            {meta.mark ? `${meta.mark} ` : ""}
            {shortLabel}
          </span>
        )}
      </button>
      {runId && onOpenRun ? (
        <button
          type="button"
          aria-label={`Open the run where ${feature.name} failed`}
          onClick={stop(() => onOpenRun(runId))}
          className={cn("mr-1 rounded p-1 hover:bg-foreground/5", focusRing)}
        >
          <ExternalLink aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}

/** A collapsed family row with its counts; expanded, its feature rows. */
export function FeatureFamilyGroup({
  model,
  expanded,
  selectedId,
  onActivate,
  onSelect,
  onOpenRun,
}: {
  model: FamilyModel;
  expanded: boolean;
  selectedId: string | null;
  /** The family row was clicked: the caller toggles it and selects it. */
  onActivate: (familyId: string) => void;
  onSelect: (featureId: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const { family } = model;
  const listId = `feature-family-${family.id}`;
  return (
    <div data-family={family.id}>
      <button
        type="button"
        data-feature-nav=""
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-current={selectedId === family.id ? "true" : undefined}
        onClick={stop(() => onActivate(family.id))}
        className={cn(
          "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-foreground/5",
          focusRing,
          selectedId === family.id && "ring-2 ring-primary/60",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13.5px] font-medium text-foreground">
            {family.name}
          </span>
          <FeatureCountsText counts={model.counts} className="text-[11.5px]" />
        </span>
      </button>
      {expanded ? (
        <ul id={listId} className="mb-1 ml-5 flex flex-col gap-0.5">
          {model.rows.map((row) => (
            <FeatureRow
              key={row.feature.id}
              row={row}
              selected={selectedId === row.feature.id}
              onSelect={onSelect}
              onOpenRun={onOpenRun}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
