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
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EVAL_WARN_BADGE_STRONG_CLASS } from "@/components/evals/constants";
import { RoleChip } from "@/components/evals/scorer-role-control";
import { ProvenanceChip } from "./provenance-chip";
import { RowMarker } from "./row-marker";
import type { JoinedScorecardRow, TrialRowResult } from "./trial-results";

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
      if (role === "gate") {
        return { Icon: XCircle, cls: "text-destructive", label: "Failed" };
      }
      if (role === "warn") {
        return {
          Icon: AlertTriangle,
          cls: EVAL_WARN_BADGE_STRONG_CLASS,
          label: "Missed · warning",
        };
      }
      return {
        Icon: Circle,
        cls: "text-muted-foreground",
        label: "Missed · reported",
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
}) {
  const isJudge = row.provenance === "judge";
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

  return (
    <li
      data-testid="trial-scorecard-row"
      data-row-key={row.key}
      data-state={row.result.state}
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
              hidden until you label this trial
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
              className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
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
              Graded as {row.evidence.frozenRole === "gating" ? "Gate" : "advisory"}{" "}
              — this scorer's role has changed since the run.
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
