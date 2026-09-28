/**
 * Compare runs — a plain table of every run in the suite, one section per lane.
 *
 * Deliberately not a chart and deliberately not a picker: the question this
 * page answers is "is this suite getting better or worse on the thing I care
 * about", and the answer is a column of numbers you can read down. The
 * comparison model lives in `run-compare-lanes-model.ts`; this file only
 * renders it.
 */
import { useMemo, useState } from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";
import type { RunMetricsByRun } from "../evals/run-metrics";
import type { EvalSuiteRun } from "../evals/types";
import { RunContextChip } from "../evals/run-context-chip";
import {
  RunCommitCell,
  RunPlatformBadge,
  readRunGitMetadata,
} from "../evals/run-git-metadata";
import { toPercent } from "../evals/suite-overview-presentation";
import type { HeroStatDelta } from "./run-verdict-hero-deltas";
import {
  buildRunCompareLanes,
  RUN_COMPARE_LANE_PREVIEW_ROWS,
  type RunCompareCell,
  type RunCompareLane,
  type RunCompareRow,
  type RunCompareStatus,
} from "./run-compare-lanes-model";

/**
 * A RESULT, not a gate verdict — same palette as the run list's own badge so
 * one run does not wear two different colours on two screens. Amber covers
 * everything still in motion or undecided; red is reserved for a real failure.
 * (Extracting one shared badge is a follow-up, not this change.)
 */
const RESULT_PILL: Record<
  RunCompareStatus,
  { label: string; className: string }
> = {
  passed: { label: "Passed", className: "bg-success/15 text-foreground" },
  failed: { label: "Failed", className: "bg-destructive/10 text-destructive" },
  inconclusive: {
    label: "Inconclusive",
    className: "bg-warning/15 text-foreground",
  },
  timed_out: { label: "Timed out", className: "bg-warning/15 text-foreground" },
  running: { label: "Running", className: "bg-warning/15 text-foreground" },
  // Finished, but nothing judged it — a run older than the `result` field.
  // Neutral rather than dimmed: it ran, it just carries no verdict.
  completed: { label: "Completed", className: "bg-muted text-foreground" },
  cancelled: {
    label: "Cancelled",
    className: "bg-muted text-muted-foreground",
  },
};

const DELTA_TONE_CLASS = {
  progress: "text-success",
  regression: "text-destructive",
  same: "text-muted-foreground",
} as const;

function RunResultPill({ status }: { status: RunCompareStatus }) {
  const pill = RESULT_PILL[status];
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded px-1.5 py-1 text-[10px] font-semibold uppercase",
        pill.className,
      )}
    >
      {pill.label}
    </span>
  );
}

/**
 * The change sits BESIDE its number rather than in a column of its own.
 *
 * Four "Δ" headers said the same word four times and never which metric they
 * belonged to, and the reader had to pair each one with the column to its
 * left. The sign already carries the direction, so the arrow that preceded it
 * was a third encoding of one fact — the colour says whether it helped.
 */
function Delta({ delta }: { delta: HeroStatDelta | null }) {
  if (!delta) return null;
  return (
    <span
      data-testid="run-compare-delta"
      className={cn(
        "ml-2 text-[11px] font-medium tabular-nums",
        DELTA_TONE_CLASS[delta.tone],
      )}
    >
      {delta.label}
    </span>
  );
}

function MetricCell({
  cell,
  detail,
}: {
  cell: RunCompareCell;
  detail?: string | null;
}) {
  return (
    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
      {cell.value ?? "—"}
      {cell.value != null && detail ? (
        <span className="ml-1 text-[10px] text-muted-foreground">
          {detail}
        </span>
      ) : null}
      <Delta delta={cell.delta} />
    </td>
  );
}

function LaneRow({
  row,
  onOpenRun,
}: {
  row: RunCompareRow;
  onOpenRun: (runId: string) => void;
}) {
  const git = readRunGitMetadata(row.run.ciMetadata ?? null);
  return (
    <tr
      className="border-b border-border/60 transition-colors hover:bg-muted/50"
      {...(row.isCurrentRun ? { "aria-current": "true" as const } : {})}
    >
      <td className="whitespace-nowrap px-3 py-2">
        <Button
          variant="link"
          className="h-auto p-0 text-xs font-semibold text-foreground"
          onClick={() => onOpenRun(row.runId)}
        >
          {row.label}
        </Button>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <RunResultPill status={row.status} />
      </td>
      <MetricCell cell={row.pass} detail={row.passDetail} />
      <td className="whitespace-nowrap px-3 py-2">
        <div className="flex items-center gap-2">
          <RunPlatformBadge run={row.run} neutral />
          {git?.commitSha ? <RunCommitCell git={git} /> : null}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
        {new Date(row.createdAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </td>
      <MetricCell cell={row.p50} />
      <MetricCell cell={row.p95} />
      <MetricCell cell={row.tokens} />
    </tr>
  );
}

const HEADER_CLASS =
  "whitespace-nowrap border-b border-border px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

function LaneSection({
  lane,
  hostNamesById,
  onOpenRun,
}: {
  lane: RunCompareLane;
  hostNamesById: Map<string, string | null>;
  onOpenRun: (runId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const hidden = lane.rows.length - RUN_COMPARE_LANE_PREVIEW_ROWS;
  const visible = expanded
    ? lane.rows
    : lane.rows.slice(0, RUN_COMPARE_LANE_PREVIEW_ROWS);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className="group/lane overflow-hidden rounded-lg border border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/50 px-3 py-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="group h-8 min-w-0 gap-2 px-1 text-sm"
            >
              <ChevronDown
                className="size-4 -rotate-90 transition-transform group-data-[state=open]:rotate-0"
                aria-hidden
              />
              <RunContextChip
                run={lane.run}
                hostNamesById={hostNamesById}
                fallbackName="Suite default"
                className="border-border bg-background shadow-none"
              />
            </Button>
          </CollapsibleTrigger>
          <span className="text-xs text-muted-foreground">
            {lane.rows.length} {lane.rows.length === 1 ? "run" : "runs"}
          </span>
        </div>
        <CollapsibleContent>
          <div className="overflow-x-auto">
            <table
              className="w-full border-collapse text-xs"
              aria-label={`Runs for ${lane.label}`}
            >
              <thead className="bg-muted/50">
                <tr>
                  <th className={HEADER_CLASS}>Run</th>
                  <th className={HEADER_CLASS}>Result</th>
                  <th className={HEADER_CLASS}>Pass</th>
                  <th className={HEADER_CLASS}>Platform</th>
                  <th className={HEADER_CLASS}>Date</th>
                  <th className={HEADER_CLASS}>P50</th>
                  <th className={HEADER_CLASS}>P95</th>
                  <th className={HEADER_CLASS}>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <LaneRow key={row.runId} row={row} onOpenRun={onOpenRun} />
                ))}
              </tbody>
            </table>
          </div>
          {hidden > 0 ? (
            <div className="px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show fewer" : `See ${hidden} more`}
              </Button>
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function RunComparisonPage({
  currentRun,
  runs,
  metricsByRun,
  suiteName,
  hostNamesById,
  passThreshold,
  onBack,
  onOpenRun,
}: {
  currentRun: EvalSuiteRun;
  runs: readonly EvalSuiteRun[];
  /** One metrics object per run — see `evals/run-metrics.ts`. */
  metricsByRun: RunMetricsByRun;
  suiteName: string;
  hostNamesById: Map<string, string | null>;
  /** The suite's pass bar as a FRACTION — see `resolveSuitePassThreshold`. */
  passThreshold: number | null;
  onBack: () => void;
  onOpenRun: (id: string) => void;
}) {
  const { header, lanes } = useMemo(
    () =>
      buildRunCompareLanes({
        currentRun,
        runs,
        metricsByRun,
        hostNamesById,
        passThreshold,
      }),
    [currentRun, runs, metricsByRun, hostNamesById, passThreshold],
  );

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="run-comparison-page"
    >
      <header className="space-y-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back to run
          </Button>
          <div>
            <h2 className="text-xl font-semibold">{suiteName}</h2>
            <p className="text-xs text-muted-foreground">
              Every run in this suite, grouped by client and model · deltas vs
              the previous run of the same lane
            </p>
          </div>
        </div>
        <p
          className="text-xs text-muted-foreground"
          data-testid="run-compare-threshold"
        >
          {header.threshold == null
            ? "No pass threshold set for this suite"
            : `Pass threshold ${toPercent(header.threshold)}% · ${
                header.lanesMeeting
              } of ${header.lanesSettled} settled lanes meet it on #${
                header.currentRunNumber
              }${
                header.lanesRunning > 0
                  ? ` · ${header.lanesRunning} still running`
                  : ""
              }`}
        </p>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {lanes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          lanes.map((lane) => (
            <LaneSection
              key={lane.key}
              lane={lane}
              hostNamesById={hostNamesById}
              onOpenRun={onOpenRun}
            />
          ))
        )}
      </div>
    </section>
  );
}
