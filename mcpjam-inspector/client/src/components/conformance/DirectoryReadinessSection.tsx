/**
 * One publisher's directory-readiness panel.
 *
 * READINESS IS NOT A SCORE, and this component is where that stays true. The
 * conformance suites above it produce numbers that pool into a headline;
 * readiness produces LANES with a status and a coverage denominator, because
 * the question it answers — "would this be listed" — has no numerator. A
 * percentage here would be invented, and an invented number is the one people
 * quote.
 *
 * The three things a lane must be able to say, and why `incomplete` is not a
 * softer `not-ready`:
 *
 *   - `ready`      — every requirement in the lane was evaluated and passed.
 *   - `not-ready`  — something was evaluated and FAILED. Actionable.
 *   - `incomplete` — something could not be evaluated. NOT a pass and not a
 *                    failure: the run is missing an input, and the coverage
 *                    line names which. A lane with zero violations and zero
 *                    evaluated checks is not a clean bill of health, and
 *                    publishing the denominator is the only way to keep those
 *                    apart.
 *
 * Model observations render beside the grade, never inside it. They are
 * informational by construction — the SDK drops any that claim otherwise — so
 * their failures (`billing-blocked`, `provider-failed`, `invalid-output`) are
 * reported as their own axis rather than as a verdict on the server.
 */

import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Info,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { OpenAISubmissionMode } from "@mcpjam/sdk/browser";
import {
  useDirectoryReadiness,
  type DirectoryReadinessState,
} from "@/hooks/use-directory-readiness";
import type {
  HostedReadinessRun,
  ReadinessLaneCoverage,
  ReadinessPublisher,
} from "@/lib/apis/mcp-readiness-api";

const PUBLISHER_LABEL: Record<ReadinessPublisher, string> = {
  claude: "Claude directory",
  openai: "OpenAI plugin directory",
};

/**
 * The submission shapes a HOSTED or LOCAL browser run can grade.
 *
 * The package shapes need an archive the browser has no way to hand over —
 * they run on the CLI — so they are absent rather than present-and-disabled. A
 * disabled option implies the surface could do it and has chosen not to.
 */
const SUBMISSION_MODES: Array<{
  value: OpenAISubmissionMode;
  label: string;
}> = [
  { value: "mcp-only", label: "MCP server only" },
  { value: "mcp-imported-skills", label: "MCP server + imported skills" },
];

function LaneIcon({ status }: { status: ReadinessLaneCoverage["status"] }) {
  if (status === "ready") {
    return (
      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />
    );
  }
  if (status === "not-ready") {
    return <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />;
  }
  // `incomplete` is deliberately NOT the same glyph as a failure: a lane
  // nobody could evaluate and a lane that failed lead to different work.
  return <CircleDashed className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />;
}

function laneTitle(lane: string): string {
  return lane
    .split("-")
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(" ");
}

function LaneRow({ coverage }: { coverage: ReadinessLaneCoverage }) {
  const total =
    coverage.evaluated + coverage.notEvaluated + coverage.notApplicable;
  return (
    <div className="flex items-start gap-1.5 px-1 py-1 text-[11px]">
      <LaneIcon status={coverage.status} />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{laneTitle(coverage.lane)}</span>{" "}
        <span className="text-muted-foreground">
          — {coverage.evaluated}/{total} evaluated
          {coverage.notApplicable > 0
            ? `, ${coverage.notApplicable} not applicable`
            : ""}
        </span>
        {coverage.missingInputs.length > 0 && (
          // The lane is `incomplete` and this is WHY. Without it the status is
          // a mystery rather than a to-do.
          <span className="block text-muted-foreground">
            Missing: {coverage.missingInputs.join(", ")}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The model-observation axis, reported separately from the grade.
 *
 * `billing-blocked` gets top-up guidance and nothing else: no retry button,
 * because retrying a refused reservation refuses again, and no error styling,
 * because the deterministic grade beside it is complete and correct.
 */
function ObservationNotice({ run }: { run?: HostedReadinessRun }) {
  const observations = run?.llmObservations;
  if (!observations || observations.status === "not-requested") return null;

  if (observations.status === "completed") {
    return (
      <div className="mx-1 my-1 flex items-start gap-1.5 rounded-sm border border-border/50 px-2 py-1.5 text-[11px]">
        <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          AI observations are included below as informational notes. They never
          change a lane's status.
        </span>
      </div>
    );
  }

  if (observations.status === "pending") {
    return (
      <div className="mx-1 my-1 flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Generating AI observations...
      </div>
    );
  }

  const blocked = observations.reason === "billing_limit_reached";
  return (
    <div className="mx-1 my-1 flex items-start gap-1.5 rounded-sm border border-amber-500/50 px-2 py-1.5 text-[11px]">
      <Info className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
      <span className="min-w-0 text-muted-foreground">
        {blocked ? (
          <>
            <span className="font-medium text-foreground">
              AI observations were skipped — MCPJam credit limit reached.
            </span>{" "}
            The readiness grade above is complete and unaffected. Add credits or
            raise the spending limit in Billing to include observations on the
            next run.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">
              AI observations were not produced.
            </span>{" "}
            {observations.detail ??
              "The grade above is complete and unaffected."}
          </>
        )}
      </span>
    </div>
  );
}

function StatusBadge({ state }: { state: DirectoryReadinessState }) {
  if (state.status === "starting" || state.status === "running") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Running
      </span>
    );
  }
  if (state.status === "cancelled") {
    return <span className="text-[10px] text-muted-foreground">Cancelled</span>;
  }
  if (state.status === "error") {
    return <span className="text-[10px] text-red-400">Error</span>;
  }
  if (state.status !== "done") return null;

  const overall = state.run?.overallStatus ?? state.result?.status;
  if (overall === "ready") {
    return <span className="text-[10px] text-green-500">Ready</span>;
  }
  if (overall === "not-ready") {
    return <span className="text-[10px] text-red-400">Not ready</span>;
  }
  return <span className="text-[10px] text-amber-500">Incomplete</span>;
}

export function DirectoryReadinessSection({
  server,
  publisher,
}: {
  server: ServerWithName;
  publisher: ReadinessPublisher;
}) {
  const {
    state,
    run,
    cancel,
    submissionMode,
    setSubmissionMode,
    includeLlmObservations,
    setIncludeLlmObservations,
    observationsAvailable,
    isRunning,
    canCancel,
  } = useDirectoryReadiness({ server, publisher });

  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? state.status !== "idle";

  const lanes: ReadinessLaneCoverage[] =
    state.run?.lanes ??
    (state.result?.lanes.map((lane) => lane.coverage) as
      | ReadinessLaneCoverage[]
      | undefined) ??
    [];

  return (
    <div className="overflow-hidden rounded-md border border-border/50">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        onClick={() => setOverride(!expanded)}
        aria-expanded={expanded}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">
            {PUBLISHER_LABEL[publisher]} readiness
          </span>
        </span>
        <StatusBadge state={state} />
      </button>

      {expanded && (
        <div className="space-y-2 px-2 py-2">
          <p className="px-1 text-[10px] text-muted-foreground">
            Lane-by-lane submission readiness. Reported separately from the
            conformance score above — readiness answers whether this server
            could be listed, not how well it scores.
          </p>

          <div className="flex flex-wrap items-center gap-2 px-1">
            <Button size="sm" onClick={run} disabled={isRunning}>
              {isRunning ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Running...
                </>
              ) : (
                "Run readiness checks"
              )}
            </Button>
            {canCancel && (
              <Button size="sm" variant="outline" onClick={cancel}>
                Cancel
              </Button>
            )}

            {publisher === "openai" && (
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="readiness-submission-mode"
                  className="text-[10px] text-muted-foreground"
                >
                  Submission
                </label>
                <Select
                  value={submissionMode}
                  onValueChange={(value) =>
                    setSubmissionMode(value as OpenAISubmissionMode)
                  }
                  disabled={isRunning}
                >
                  <SelectTrigger
                    id="readiness-submission-mode"
                    className="h-8 w-[220px] text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUBMISSION_MODES.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {observationsAvailable && (
            // Opt-in, unchecked, and the cost is in the label rather than in a
            // tooltip: a control that spends should say so where it is
            // clicked.
            <label className="flex cursor-pointer items-start gap-1.5 px-1 text-[11px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={includeLlmObservations}
                disabled={isRunning}
                onChange={(event) =>
                  setIncludeLlmObservations(event.target.checked)
                }
              />
              <span className="text-muted-foreground">
                Add AI observations (uses MCPJam credits). Informational only —
                they never change a lane's status.
              </span>
            </label>
          )}

          {state.status === "error" && state.error && (
            <div className="px-1 py-1 text-[11px] text-red-400">
              {state.error}
            </div>
          )}
          {state.status === "cancelled" && (
            <div className="px-1 py-1 text-[11px] text-muted-foreground">
              This run was cancelled. Nothing further was sent to the server.
            </div>
          )}

          <ObservationNotice run={state.run} />

          {lanes.length > 0 ? (
            <div>
              {lanes.map((coverage) => (
                <LaneRow key={coverage.lane} coverage={coverage} />
              ))}
              {state.status === "done" &&
                state.run?.hasReport === true &&
                !state.result && (
                  // The lanes ARE the verdict; only the per-finding evidence is
                  // missing. Saying so beats rendering a blank findings list
                  // that reads as "nothing found".
                  <div className="flex items-start gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                    <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                    The detailed report could not be loaded. Lane statuses above
                    are still this run's verdict.
                  </div>
                )}
            </div>
          ) : isRunning ? (
            <div className="flex items-center gap-2 px-1 py-3 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Grading {PUBLISHER_LABEL[publisher]} lanes...
            </div>
          ) : (
            <div className="px-1 py-2 text-[10px] text-muted-foreground">
              Not run yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
