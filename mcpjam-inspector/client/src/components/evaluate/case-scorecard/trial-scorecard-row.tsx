import { expectationOf } from "./case-scorecard-model";
/**
 * One scorer, with what happened to it.
 *
 * The glyph is `state × role`, and that pairing is the whole point: an
 * advisory miss is a real `failed` fact, but it did not fail the trial, so it
 * wears an amber Warn rather than a red cross. Reading role off the row and
 * state off the server keeps the page from either hiding a miss or promoting
 * one into a failure the verdict does not agree with.
 */

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  CircleHelp,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RoleChip } from "@/components/evals/scorer-role-control";
import { ProvenanceChip } from "./provenance-chip";
import { RowMarker } from "./row-marker";
import type { JoinedScorecardRow, TrialRowResult } from "./trial-results";
import { isRequiredRole } from "@mcpjam/sdk/predicates";

type Glyph = {
  Icon: typeof CheckCircle2;
  cls: string;
  /** Read out on hover and by a screen reader; never only a colour. */
  label: string;
};

export function resultGlyph(
  result: TrialRowResult,
  role: JoinedScorecardRow["role"],
): Glyph {
  switch (result.state) {
    case "passed":
      return { Icon: CheckCircle2, cls: "text-success", label: "Passed" };
    case "failed":
      if (role === "required") {
        return { Icon: XCircle, cls: "text-destructive", label: "Failed" };
      }
      // One advisory glyph. Warn and Report differed only by this icon and
      // its colour, and neither changed the iteration's verdict.
      return {
        Icon: Circle,
        cls: "text-muted-foreground",
        label: "Missed · advisory",
      };
    case "uncertain":
      // Neither a pass nor a miss: the classifier's answer sat too close to
      // even odds to call. The value beside it says how close.
      return {
        Icon: CircleHelp,
        cls: "text-muted-foreground",
        label: "Uncertain",
      };
    case "error":
      return {
        Icon: AlertTriangle,
        cls: "text-amber-600 dark:text-amber-400",
        label: "Could not be evaluated",
      };
    case "skipped":
      return {
        Icon: MinusCircle,
        cls: "text-muted-foreground",
        label: "Skipped",
      };
    case "notApplicable":
      return {
        Icon: MinusCircle,
        cls: "text-muted-foreground",
        label: "Not applicable",
      };
    case "pending":
      return {
        Icon: Loader2,
        cls: "animate-spin text-muted-foreground",
        label: "Running",
      };
    default:
      return {
        Icon: CircleDashed,
        cls: "text-muted-foreground/50",
        label: "Not measured",
      };
  }
}

function formatValue(result: TrialRowResult): string | null {
  if (!("value" in result) || typeof result.value !== "number") return null;
  const value = result.value.toFixed(2);
  const threshold =
    "threshold" in result && typeof result.threshold === "number"
      ? result.threshold.toFixed(2)
      : null;
  return threshold ? `${value} / ${threshold}` : value;
}

export function TrialScorecardRow({
  row,
  body,
  hideJudgeResult = false,
  syncedStepId,
  onSyncStep,
  layout = "row",
}: {
  row: JoinedScorecardRow;
  /** The judge row's panel, which owns the blind-label protocol. */
  body?: React.ReactNode;
  /**
   * Withhold this row's own judge output while a blind label is being taken.
   *
   * A reviewer's label is counted toward calibration only when it was made
   * without seeing the judge — the panel asserts `blind: true` from its own
   * reveal state, and it cannot know what the row around it printed. This row
   * showed the score, the glyph and the rationale beside the very control that
   * records the label, so a label taken there was recorded as blind while the
   * answer was on screen. Calibration gates other people's builds, so it fails
   * closed: hidden until the panel says it was revealed.
   */
  hideJudgeResult?: boolean;
  syncedStepId?: string | null;
  onSyncStep?: (stepId: string | null) => void;
  layout?: "row" | "report";
}) {
  // Rubric checks are judge output too: a blind label taken beside them is
  // not blind, so they are withheld with the goal judge's own row.
  const isJudge = row.provenance === "judge" || row.provenance === "rubricCheck";
  const withheld = isJudge && hideJudgeResult;
  const reason = withheld
    ? undefined
    : "reason" in row.result
      ? row.result.reason
      : undefined;
  const evidence = withheld ? [] : (row.evidence?.scoreEvidence ?? []);
  const expandable = Boolean(reason || evidence.length > 0);
  const [open, setOpen] = useState(false);
  const glyph = resultGlyph(
    withheld ? { state: "notMeasured" } : row.result,
    row.role,
  );
  const value = withheld ? undefined : formatValue(row.result);
  const active = row.stepId !== undefined && syncedStepId === row.stepId;

  if (layout === "report") {
    // ACTUAL is one cell: the model's narrative when it is current, else the
    // recorded reason with the measured evidence under it, else the bare
    // value. A separate "why" line restated the reason a second time.
    const narrative =
      row.narrative && !row.narrative.stale ? row.narrative.text : null;
    const recorded = [...(reason ? [reason] : []), ...evidence];
    const actual =
      narrative ??
      (recorded.length
        ? recorded.join("\n")
        : value || "No observation recorded.");
    return (
      <li
        className={cn(
          "space-y-3 border-b border-border/60 py-4 last:border-b-0",
          // The step rail highlights this row, not only the other way round:
          // `onSyncStep` fires from here on hover, so the sync has to be
          // legible in both directions or it reads as broken from one side.
          active && "-mx-2 rounded-md bg-primary/5 px-2",
        )}
        data-testid="trial-scorecard-row"
        data-row-key={row.key}
        data-state={withheld ? "notMeasured" : row.result.state}
        data-role={row.role}
        {...(row.stepId ? { "data-step-id": row.stepId } : {})}
        onMouseEnter={() => row.stepId && onSyncStep?.(row.stepId)}
        onMouseLeave={() => row.stepId && onSyncStep?.(null)}
      >
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-base font-semibold">{row.label}</h4>
          <span
            className={cn(
              "shrink-0 rounded px-2 py-1 text-[10px] font-semibold uppercase",
              withheld
                ? "bg-muted text-muted-foreground"
                : cn(
                    row.result.state === "passed"
                      ? "bg-success/15"
                      : row.result.state === "failed" && row.role === "required"
                        ? "bg-destructive/10"
                        : "bg-muted",
                    // Success stays in the tint; small text needs the reading
                    // foreground rather than the low-contrast icon colour.
                    row.result.state === "passed"
                      ? "text-foreground"
                      : glyph.cls.replace("animate-spin", "").trim(),
                  ),
            )}
          >
            {withheld ? "Hidden" : glyph.label}
          </span>
        </div>
        {withheld ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="judge-result-withheld"
          >
            hidden until you label this iteration
          </p>
        ) : (
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm leading-relaxed sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Expected
            </dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">
              {expectationOf(row)}
            </dd>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Actual
            </dt>
            <dd
              className="min-w-0 whitespace-pre-wrap break-words"
              data-testid="trial-scorecard-reason"
            >
              <span data-narrative-source={narrative ? "ai" : "recorded"}>
                {actual}
              </span>
              {row.narrative?.stale && (
                <p className="mt-1 text-muted-foreground">
                  Narrative predates the latest grade.
                </p>
              )}
            </dd>
          </dl>
        )}
        {row.evidence?.frozenRole && !withheld && (
          <p className="text-xs text-muted-foreground">
            Graded as{" "}
            {isRequiredRole(row.evidence.frozenRole) ? "required" : "advisory"}{" "}
            — this scorer's role has changed since the run.
          </p>
        )}
        {body && <div className="pt-2">{body}</div>}
      </li>
    );
  }

  return (
    <li
      data-testid="trial-scorecard-row"
      data-row-key={row.key}
      data-state={withheld ? "notMeasured" : row.result.state}
      data-role={row.role}
      {...(row.stepId ? { "data-step-id": row.stepId } : {})}
      onMouseEnter={() => row.stepId && onSyncStep?.(row.stepId)}
      onMouseLeave={() => row.stepId && onSyncStep?.(null)}
      className={cn(
        "rounded-md border bg-background/40",
        active ? "border-primary/50 bg-primary/5" : "border-border/50",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <RowMarker row={row} />
        <ProvenanceChip provenance={row.provenance} />
        <glyph.Icon
          className={cn("h-3.5 w-3.5 shrink-0", glyph.cls)}
          aria-label={glyph.label}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {row.label}
          {withheld ? (
            <span
              className="ml-2 text-[11px] text-muted-foreground"
              data-testid="judge-result-withheld"
            >
              hidden until you label this iteration
            </span>
          ) : null}
        </span>
        {value ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {value}
          </span>
        ) : null}
        <RoleChip role={row.role} />
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Why ${row.label}`}
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        ) : null}
      </div>

      {open && expandable ? (
        <div className="space-y-1 border-t border-border/50 px-2.5 py-2">
          {reason ? (
            <p
              className="text-[11px] leading-snug text-muted-foreground"
              data-testid="trial-scorecard-reason"
            >
              {reason}
            </p>
          ) : null}
          {evidence.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4">
              {evidence.map((item, index) => (
                <li key={index} className="text-[11px] text-muted-foreground">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
          {row.evidence?.frozenRole ? (
            <p className="text-[11px] text-muted-foreground/80">
              Graded as{" "}
              {isRequiredRole(row.evidence.frozenRole) ? "required" : "advisory"}{" "}
              —
              this scorer's role has changed since the run.
            </p>
          ) : null}
        </div>
      ) : null}

      {body ? (
        <div className="border-t border-border/50 px-2.5 py-2">{body}</div>
      ) : null}
    </li>
  );
}
