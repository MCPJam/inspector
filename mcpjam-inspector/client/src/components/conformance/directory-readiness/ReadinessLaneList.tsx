/**
 * Lanes, their grades, and — the part that matters — what was never looked at.
 *
 * COVERAGE TRAVELS WITH THE VERDICT, the same rule `ScoreHeadline` follows for
 * the conformance score. A lane reading "ready" over three evaluated checks
 * and five that never ran is not the same statement as one reading "ready"
 * over eight, and a row that showed only the word would make them look
 * identical. So every lane prints its evaluated count, and every lane with a
 * gap prints what would close it.
 *
 * `missingInputs` is the actionable half: the engine already knows the run
 * lacked a tool listing or a submission profile, and naming it turns "we could
 * not tell" into "supply this and we can".
 */

import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { describeMissingInputs } from "./readiness-copy";

type LaneStatus = "ready" | "not-ready" | "incomplete";

export interface ReadinessLaneRow {
  lane: string;
  status: LaneStatus;
  evaluated: number;
  notEvaluated: number;
  notApplicable: number;
  missingInputs: string[];
}

export interface ReadinessStageRow {
  stage: string;
  status: LaneStatus;
  lanes: string[];
}

function LaneIcon({ status }: { status: LaneStatus }) {
  if (status === "ready") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  }
  if (status === "not-ready") {
    return <XCircle className="h-3.5 w-3.5 text-red-400" />;
  }
  return <MinusCircle className="h-3.5 w-3.5 text-amber-500" />;
}

/** `runtime-compatibility` -> `Runtime compatibility`. */
function laneLabel(lane: string): string {
  const spaced = lane.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STAGE_LABEL: Record<string, string> = {
  "technical-preflight": "Technical preflight",
  "submission-ready": "Submission ready",
};

export function ReadinessLaneList({
  lanes,
  stages,
}: {
  lanes: ReadinessLaneRow[];
  stages?: ReadinessStageRow[];
}) {
  // Stages render even with no lane rows: when the full report is mounted
  // below, this component's only remaining job is the two OpenAI rollup chips.
  if (lanes.length === 0 && (!stages || stages.length === 0)) return null;

  return (
    <div className="space-y-2">
      {/*
        OpenAI grades two rollups from one set of findings, and the narrower
        one has to stay visible beside the headline: a submitter whose server
        is fine and whose paperwork is not should read that without opening
        anything.
      */}
      {stages && stages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {stages.map((stage) => (
            <span
              key={stage.stage}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-[10px]"
            >
              <LaneIcon status={stage.status} />
              <span className="text-muted-foreground">
                {STAGE_LABEL[stage.stage] ?? stage.stage}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="divide-y divide-border/40">
        {lanes.map((lane) => {
          const total = lane.evaluated + lane.notEvaluated;
          const hasGap = lane.notEvaluated > 0 || lane.missingInputs.length > 0;
          return (
            <div key={lane.lane} className="px-1 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <LaneIcon status={lane.status} />
                  <span className="text-xs truncate">
                    {laneLabel(lane.lane)}
                  </span>
                </span>
                {/*
                  The denominator travels with the number. `notApplicable` is
                  stated separately rather than folded in, because "does not
                  apply here" and "was not checked" are different facts.
                */}
                <span className="text-[10px] tabular-nums text-muted-foreground flex-shrink-0">
                  {lane.evaluated}/{total} evaluated
                  {lane.notApplicable > 0 ? ` · ${lane.notApplicable} n/a` : ""}
                </span>
              </div>
              {hasGap && (
                <div className="pl-5 pt-0.5 text-[10px] text-amber-600 dark:text-amber-500">
                  {lane.missingInputs.length > 0
                    ? describeMissingInputs(lane.missingInputs).join(" ")
                    : `${lane.notEvaluated} requirement(s) could not be evaluated.`}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
