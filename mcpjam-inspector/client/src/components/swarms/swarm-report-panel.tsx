import type { JourneySessionRow } from "@/lib/swarm-api";
import { useQuery } from "convex/react";
import type { SwarmReport, SwarmSessionVerdict } from "@mcpjam/sdk/contract";
import { USER_VALUE_STAGE_LABELS } from "@mcpjam/sdk/contract";
import { SessionUserValueChain } from "@/components/shared/user-value-chain/SessionUserValueChain";
import type { ChatSessionStageDerivation } from "@/components/shared/user-value-chain/user-value-chain-types";
import { ErrorBoundary } from "@/components/ui/error-boundary";
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
    <span className={`text-xs ${badge.tone}`} title={verdict?.reason}>
      Goal result: {badge.label}
    </span>
  );
}
function SessionChainQuery({ sessionId }: { sessionId: string }) {
  const derivation = useQuery(
    "chatSessionStageDerivation:getChatSessionStageDerivation" as never,
    { sessionId } as never,
  ) as ChatSessionStageDerivation | null | undefined;
  return <SessionUserValueChain derivation={derivation ?? null} />;
}
export function SwarmSessionChain({ sessionId }: { sessionId?: string }) {
  if (!sessionId)
    return (
      <p className="text-xs text-muted-foreground">
        User value chain: Not measured
      </p>
    );
  return (
    <ErrorBoundary
      fallback={
        <p className="text-xs text-muted-foreground">
          User value chain: Not measured
        </p>
      }
    >
      <SessionChainQuery sessionId={sessionId} />
    </ErrorBoundary>
  );
}
export function SwarmReportPanel({ report }: { report?: SwarmReport }) {
  if (!report)
    return (
      <p className="text-xs text-muted-foreground">
        Run decision not available.
      </p>
    );
  const badge = runVerdictBadge(report.verdict);
  const e = report.execution,
    g = report.goalGrading;
  return (
    <section
      className="space-y-2 rounded-lg border border-border p-3"
      aria-label="Swarm report"
    >
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
        Each target requires all graded sessions to pass, with sufficient
        execution and grading coverage. Interrupted executions remain excluded
        even when their goal was met.
      </p>
      {report.observations.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Check observations</p>
          {report.observations.map((o) => (
            <p key={o.evaluatorId} className="text-xs text-muted-foreground">
              {USER_VALUE_STAGE_LABELS[o.stage]} ·{" "}
              {observationLabel(o.predicateType)} ({o.role}):{" "}
              {o.passed + o.failed}/{o.total} sessions measured · {o.failed}{" "}
              findings · {o.pending} pending · {o.unavailable} unavailable
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
  return (
    <div className="space-y-2">
      {session?.verdict && (
        <p className="text-xs text-muted-foreground">
          Execution: {lifecycleChip(session.verdict.lifecycle).label}
        </p>
      )}
      <SwarmGoalResult verdict={session?.verdict} />
      {session?.goalScore?.reason && (
        <p className="text-xs text-muted-foreground">
          {session.goalScore.reason}
        </p>
      )}
      {session?.verdict?.lifecycle === "broke" &&
        session.verdict.verdict === "passed" && (
          <p className="text-xs text-muted-foreground">
            The goal was met, but execution was interrupted. This session is
            excluded from completed execution coverage.
          </p>
        )}
      {session?.observations?.map((o) => (
        <p key={o.evaluatorId} className="text-xs text-muted-foreground">
          {observationLabel(o.predicateType)} ({o.role}):{" "}
          {o.status === "unavailable"
            ? "Not measured"
            : o.status === "failed"
            ? "Finding"
            : o.status === "pending"
            ? "Checking"
            : "Passed"}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          User value chain
        </summary>
        <div className="mt-2">
          <SwarmSessionChain sessionId={session?.id} />
        </div>
      </details>
    </div>
  );
}
