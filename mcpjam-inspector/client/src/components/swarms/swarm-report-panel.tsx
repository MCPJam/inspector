import type { JourneySessionRow } from "@/lib/swarm-api";
import type { SwarmReport, SwarmSessionVerdict } from "@mcpjam/sdk/contract";
import { USER_VALUE_STAGE_LABELS } from "@mcpjam/sdk/contract";
import {
  observationLabel,
  lifecycleChip,
  runVerdictBadge,
  verdictBadge,
} from "./swarm-verdict-presentation";
export function SwarmGoalResult({
  verdict,
}: {
  verdict?: SwarmSessionVerdict;
}) {
  const badge = verdictBadge(verdict);
  return (
    <span className={`text-xs ${badge.tone}`}>Goal result: {badge.label}</span>
  );
}
export function SwarmReportPanel({
  report,
  title,
}: {
  report?: SwarmReport;
  title?: string;
}) {
  if (!report) return null;
  const badge = runVerdictBadge(report.verdict);
  const e = report.execution,
    g = report.goalGrading;
  return (
    <section
      className="space-y-2 rounded-lg border border-border p-3"
      aria-label="Swarm report"
    >
      {title && <p className="text-sm font-medium">{title}</p>}
      <p className={`text-sm font-medium ${badge.tone}`}>
        Run decision:{" "}
        {report.undecidedReason === "gradingPending"
          ? "Grading"
          : report.undecidedReason === "executionPending"
            ? "Running"
            : badge.label}
      </p>
      <p className="text-xs text-muted-foreground">
        Execution: {e.started}/{e.configured} sessions started · {e.completed}{" "}
        completed · {e.interrupted} interrupted · {e.notStarted} not started ·{" "}
        {e.unknown} unknown
      </p>
      <p className="text-xs">
        Goal grading: {g.passed} passed · {g.failed} failed · {g.pending}{" "}
        pending · {g.unavailable} unavailable · {g.notRequested} not requested
      </p>
      <p className="text-xs text-muted-foreground">
        {report.decision
          ? `Target pass thresholds: ${[
              ...new Set(
                report.decision.cases.map(
                  (c) => `${Math.round(c.effectivePassThreshold * 100)}%`,
                ),
              ),
            ].join(", ")}. `
          : "Pass threshold unavailable. "}
        Interrupted executions remain excluded even when their goal was met.
      </p>
      {report.observations.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Evaluators</p>
          {report.observations.map((o) => (
            <p key={o.evaluatorId} className="text-xs text-muted-foreground">
              {USER_VALUE_STAGE_LABELS[o.stage]} ·{" "}
              {observationLabel(o.predicateType)}: {o.passed + o.failed}/
              {o.total} sessions measured · {o.failed} findings · {o.pending}{" "}
              pending · {o.unavailable} unavailable
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

export function SwarmSessionReport({
  session,
}: {
  session?: JourneySessionRow | null;
}) {
  const executionLabel = session?.verdict
    ? lifecycleChip(session.verdict.lifecycle).label
    : null;
  const reason = session?.goalScore?.reason;
  const interruptedPassed =
    session?.verdict?.lifecycle === "broke" &&
    session.verdict.verdict === "passed";
  const observations = session?.observations ?? [];
  if (
    !executionLabel &&
    !reason &&
    !interruptedPassed &&
    observations.length === 0
  ) {
    return null;
  }
  return (
    <div className="space-y-2">
      {executionLabel && (
        <p className="text-xs text-muted-foreground">
          Execution: {executionLabel}
        </p>
      )}
      {reason && (
        <p className="text-xs text-muted-foreground">{reason}</p>
      )}
      {interruptedPassed && (
        <p className="text-xs text-muted-foreground">
          The goal was met, but execution was interrupted. This session is
          excluded from completed execution coverage.
        </p>
      )}
      {observations.map((o) => (
        <p key={o.evaluatorId} className="text-xs text-muted-foreground">
          {observationLabel(o.predicateType)}:{" "}
          {o.status === "unavailable"
            ? "Not measured"
            : o.status === "failed"
              ? "Finding"
              : o.status === "pending"
                ? "Checking"
                : "Passed"}
        </p>
      ))}
    </div>
  );
}
