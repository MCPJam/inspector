/**
 * One publisher's directory-readiness section on /conformance.
 *
 * ## Why this is not a `SuiteSection`
 *
 * It borrows the visual grammar deliberately — same header, same badge ladder,
 * same collapse behaviour — so the page reads as one thing. What it cannot
 * borrow is the CONTENT model. A suite renders checks that passed or failed
 * and a score out of a hundred. Readiness renders lanes that were evaluated to
 * some degree, findings whose class decides whether they count, coverage that
 * says what was never looked at, and a paid observation pass that can be
 * refused without the run failing. There is no score, on purpose.
 *
 * ## The three axes, kept apart
 *
 * `status` is whether the run finished. `overallStatus` is the grade.
 * `llmObservations.status` is whether the optional paid pass ran. A completed
 * run can be `not-ready`; a run whose observations were refused for credit is
 * still a complete, valid grade. Collapsing any two of them into one badge is
 * the misreading this product exists to prevent, so the header shows the grade
 * and the observation state gets its own line.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  XCircle,
} from "lucide-react";
import {
  CLAUDE_READINESS_LANES,
  OPENAI_READINESS_LANES,
  isOpenAIReadinessResult,
} from "@mcpjam/sdk/browser";
import { useDirectoryReadinessRun } from "@/hooks/use-directory-readiness-run";
import {
  HOSTED_SUBMISSION_MODES,
  type DirectoryReadinessPublisher,
  type HostedSubmissionMode,
} from "@/lib/apis/directory-readiness-api";
import { DirectoryReadinessReport } from "./DirectoryReadinessReport";
import { ReadinessLaneList } from "./ReadinessLaneList";
import { detectAuthWall } from "./readiness-copy";
import { ObservationNotice } from "./ObservationNotice";

const PUBLISHER_LABEL: Record<DirectoryReadinessPublisher, string> = {
  claude: "Claude Directory Readiness",
  openai: "OpenAI Directory Readiness",
};

/**
 * Why each package mode is offered but disabled.
 *
 * Listed rather than hidden: a submitter grading a plugin that ships skills
 * needs to learn that this surface cannot do it and which one can. A silently
 * shorter menu teaches nothing.
 */
const PACKAGE_MODE_NOTE =
  "needs a package on your machine — run `mcpjam readiness check`";

const ALL_SUBMISSION_MODES = [
  { value: "mcp-only", label: "MCP server only", hosted: true },
  {
    value: "mcp-imported-skills",
    label: "MCP + imported skills",
    hosted: true,
  },
  { value: "skills-only", label: "Skills package only", hosted: false },
  {
    value: "mcp-uploaded-skills",
    label: "MCP + uploaded skills",
    hosted: false,
  },
] as const;

function lanesFor(publisher: DirectoryReadinessPublisher): readonly string[] {
  return publisher === "openai"
    ? OPENAI_READINESS_LANES
    : CLAUDE_READINESS_LANES;
}

function gradeBadge(
  grade: "ready" | "not-ready" | "incomplete" | null | undefined,
) {
  if (grade === "ready") {
    return <span className="text-[10px] text-green-500">Ready</span>;
  }
  if (grade === "not-ready") {
    return <span className="text-[10px] text-red-400">Not ready</span>;
  }
  if (grade === "incomplete") {
    return <span className="text-[10px] text-amber-500">Incomplete</span>;
  }
  return null;
}

export function DirectoryReadinessSection({
  publisher,
  server,
}: {
  publisher: DirectoryReadinessPublisher;
  server: { name: string; config?: unknown };
}) {
  const [submissionMode, setSubmissionMode] =
    useState<HostedSubmissionMode>("mcp-only");
  const [includeLlmObservations, setIncludeLlmObservations] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);

  const { state, hosted, run, cancel, loadReport, rediscover } =
    useDirectoryReadinessRun({
      publisher,
      server,
      submissionMode: publisher === "openai" ? submissionMode : undefined,
      includeLlmObservations,
    });

  // A reload mid-run finds its way back to the run that is still going. Every
  // other suite on this page loses its result on refresh; readiness is the one
  // that persists, so not offering this would be throwing away the difference.
  useEffect(() => {
    void rediscover();
  }, [rediscover]);

  const running = state.status === "running";
  const collapsible = state.status !== "unavailable";
  const grade = state.report
    ? (state.report.status as "ready" | "not-ready" | "incomplete")
    : state.run?.overallStatus ?? null;
  const hasResult = Boolean(state.report || state.run);
  // OPEN BY DEFAULT, unlike the suite sections beside it — and for a concrete
  // reason rather than prominence. Their run control is the page's shared
  // "Run available checks" button, so a collapsed suite is still runnable.
  // Readiness owns its own controls, so a collapsed section would hide the
  // only way to start one, along with the submission mode it needs declared.
  const expanded = collapsible && (override ?? true);

  const catalogLanes = useMemo(() => lanesFor(publisher), [publisher]);

  const onToggle = useCallback(() => {
    const next = !expanded;
    setOverride(next);
    // The report is megabytes and the row already carries the lane summary, so
    // it is fetched when somebody actually opens the findings.
    if (next) void loadReport();
  }, [expanded, loadReport]);

  const badge = (() => {
    if (running) {
      return (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {state.run?.status === "pending" ? "Queued" : "Running"}
        </span>
      );
    }
    if (state.status === "unavailable") {
      return (
        <span className="text-[10px] text-muted-foreground">Unavailable</span>
      );
    }
    if (state.status === "error") {
      return <span className="text-[10px] text-red-400">Error</span>;
    }
    // A run that FAILED never produced a grade; saying "not ready" here would
    // report our own failure as a verdict about somebody's server.
    if (state.run && state.run.status === "failed") {
      return <span className="text-[10px] text-red-400">Run failed</span>;
    }
    if (state.run && state.run.status === "cancelled") {
      return (
        <span className="text-[10px] text-muted-foreground">Cancelled</span>
      );
    }
    return gradeBadge(grade);
  })();

  return (
    <div className="rounded-md border border-border/50 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-muted/30 text-left transition-colors enabled:hover:bg-muted/50 disabled:cursor-default"
        onClick={onToggle}
        disabled={!collapsible}
        aria-expanded={collapsible ? expanded : undefined}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {collapsible &&
            (expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ))}
          <span className="text-sm font-medium truncate">
            {PUBLISHER_LABEL[publisher]}
          </span>
        </span>
        <span className="flex items-center gap-2">{badge}</span>
      </button>

      <div className="px-2 py-1">
        {state.status === "unavailable" && state.unavailableReason && (
          <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            {state.unavailableReason}
          </div>
        )}
        {state.status === "error" && state.error && (
          <div className="px-1 py-2 text-xs text-red-400">{state.error}</div>
        )}

        {expanded && (
          <div className="space-y-2 pb-1">
            <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
              <button
                type="button"
                onClick={() => void run()}
                disabled={running || state.status === "unavailable"}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <Play className="h-3 w-3" />
                {hasResult ? "Run again" : "Run readiness"}
              </button>

              {running && hosted && (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
                >
                  <XCircle className="h-3 w-3" />
                  Cancel
                </button>
              )}

              {publisher === "openai" && (
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  Submission
                  <select
                    value={submissionMode}
                    onChange={(event) =>
                      setSubmissionMode(
                        event.target.value as HostedSubmissionMode,
                      )
                    }
                    disabled={running}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
                  >
                    {ALL_SUBMISSION_MODES.map((mode) => {
                      const available = (
                        HOSTED_SUBMISSION_MODES as readonly string[]
                      ).includes(mode.value);
                      return (
                        <option
                          key={mode.value}
                          value={mode.value}
                          disabled={!available}
                        >
                          {mode.label}
                          {available ? "" : ` — ${PACKAGE_MODE_NOTE}`}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {hosted && (
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeLlmObservations}
                    onChange={(event) =>
                      setIncludeLlmObservations(event.target.checked)
                    }
                    disabled={running}
                    className="h-3 w-3"
                  />
                  Add AI observations (uses MCPJam credits)
                </label>
              )}
            </div>

            {/* The AI axis, on its own line, because it is its own answer. */}
            {state.run?.llmObservations && (
              <ObservationNotice observations={state.run.llmObservations} />
            )}

            {hasResult ? (
              <>
                {/*
                  THE GAP, TURNED INTO ITS ACTION. The run already proved two
                  things: we carried no token, and the server challenged
                  correctly — which is a green mark for them, not a red one.
                  Connecting is all it takes: a hosted run reads the saved
                  server's token automatically, so there is nothing readiness-
                  specific to configure. Parity note: the suites above answer
                  the same situation with a raw 401 in a red box, so this is
                  the page's first section to say the next step out loud.
                */}
                {(() => {
                  const wall = state.report
                    ? detectAuthWall(state.report)
                    : null;
                  if (!wall) return null;
                  return (
                    <div className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px] leading-relaxed">
                      This server requires OAuth, and this run carried no token
                      — {wall.waiting} check(s) are waiting on an authorized
                      session.{" "}
                      {hosted
                        ? "Connect the server (server menu → reconnect with OAuth), then run again; the saved token is used automatically."
                        : "Connect the server with OAuth from the server menu, then run again."}
                    </div>
                  );
                })()}
                {/* OpenAI's two staged rollups, visible beside the headline:
                    a submitter whose server is fine and whose paperwork is
                    not reads that here without opening anything. */}
                <ReadinessLaneList
                  lanes={state.report ? [] : state.run?.lanes ?? []}
                  stages={
                    state.report && isOpenAIReadinessResult(state.report)
                      ? state.report.stages
                      : state.run?.stages ?? []
                  }
                />
                <DirectoryReadinessReport
                  report={state.report}
                  loading={state.reportLoading}
                  error={state.reportError}
                  hasReport={
                    state.report ? true : state.run?.hasReport ?? false
                  }
                  terminalReason={state.run?.terminalReason ?? undefined}
                  errorMessage={state.run?.errorMessage ?? undefined}
                />
              </>
            ) : running ? (
              <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Grading {catalogLanes.length} lanes...
              </div>
            ) : (
              <div className="px-1 py-1 text-[10px] text-muted-foreground">
                {catalogLanes.length} lanes graded against{" "}
                {publisher === "openai" ? "OpenAI's" : "Anthropic's"} published
                directory rules — not run yet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
