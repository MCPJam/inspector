import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  swarmAttemptChatSessionId,
  type JourneySessionRow,
  type SessionGoalScore,
} from "@/lib/swarm-api";
import { formatScore } from "@/components/shared/session-quality/judge-presentation";
import { TraceViewer } from "@/components/evals/trace-viewer";
import {
  TraceViewModeTabs,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import {
  swarmCellKey,
  type JourneyRunStreamState,
  type SwarmCellLiveStatus,
} from "./use-journey-run-stream";
import { usePersistedSessionTrace } from "./use-persisted-session-trace";

export type SwarmMatrixCellOutcome =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rate_limited";

const CELL_META: Record<
  SwarmMatrixCellOutcome,
  { label: string; dot: string; text: string }
> = {
  pending: {
    label: "Pending",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  running: {
    label: "Running",
    dot: "bg-muted-foreground animate-pulse",
    text: "text-muted-foreground",
  },
  succeeded: {
    label: "Done",
    dot: "bg-success",
    text: "text-success",
  },
  failed: {
    label: "Fail",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  rate_limited: {
    label: "Limited",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
};

export function resolveSwarmCellOutcome(args: {
  liveStatus?: SwarmCellLiveStatus;
  session?: JourneySessionRow | null;
  runStatus: string;
}): SwarmMatrixCellOutcome {
  const { liveStatus, session, runStatus } = args;
  if (liveStatus && liveStatus !== "pending") {
    return liveStatus;
  }
  if (!session) {
    // Unpersisted attempt: pending while the run is live; otherwise treat as
    // failed-shaped empty (host summary failures show as Fail via liveStatus
    // or missing rows under a non-running run stay pending until selected).
    if (runStatus === "running") return "pending";
    return "pending";
  }
  if (session.status === "failed") return "failed";
  if (session.status === "rate_limited") return "rate_limited";
  if (session.status === "completed" || session.status === "succeeded") {
    return "succeeded";
  }
  // Chat-session lifecycle often sticks at `active` after the journey run
  // finishes — that is NOT "still running". Only pulse Running while the
  // journey run itself is in flight.
  if (session.status === "running" || session.status === "active") {
    return runStatus === "running" ? "running" : "succeeded";
  }
  if (runStatus === "running") return "running";
  return "pending";
}

function GoalScoreHint({ score }: { score?: SessionGoalScore }) {
  if (score?.score == null) return null;
  return (
    <span className="text-[10px] tabular-nums text-muted-foreground">
      {formatScore(score.score)}
      {score.passed != null ? (score.passed ? " · pass" : " · miss") : ""}
    </span>
  );
}

export function SwarmHostCell({
  outcome,
  goalScore,
  selected,
  onSelect,
}: {
  outcome: SwarmMatrixCellOutcome;
  goalScore?: SessionGoalScore;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = CELL_META[outcome];
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="swarm-host-cell"
      data-outcome={outcome}
      className={cn(
        "flex min-h-[3.25rem] w-full flex-col items-start justify-center gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5"
          : "border-border/50 bg-background/60",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", meta.dot)} />
        <span className={cn("text-[11px] font-semibold", meta.text)}>
          {meta.label}
        </span>
      </span>
      <GoalScoreHint score={goalScore} />
    </button>
  );
}

export type SwarmMatrixSelection = {
  hostId: string;
  sessionIndex: number;
  chatSessionId: string;
};

export function SwarmSessionsMatrix({
  runId,
  hostIds,
  hostName,
  sessionsPerHost,
  sessions,
  hostSummaries,
  stream,
  runStatus,
  selection,
  onSelect,
}: {
  runId: string;
  hostIds: string[];
  hostName: (id: string) => string;
  sessionsPerHost: number;
  sessions: JourneySessionRow[];
  hostSummaries: Array<{
    hostId: string;
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  }>;
  stream: JourneyRunStreamState;
  runStatus: string;
  selection: SwarmMatrixSelection | null;
  onSelect: (sel: SwarmMatrixSelection) => void;
}) {
  const sessionByChatId = useMemo(() => {
    const map = new Map<string, JourneySessionRow>();
    for (const s of sessions) {
      map.set(s.chatSessionId, s);
    }
    return map;
  }, [sessions]);

  const rows = Math.max(1, sessionsPerHost);

  return (
    <div
      className="min-w-0 overflow-x-auto rounded-lg border border-border/60"
      data-testid="swarm-sessions-matrix"
    >
      <table className="w-full min-w-[28rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-border/50 bg-muted/20">
            <th className="sticky left-0 z-[1] bg-muted/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Session
            </th>
            {hostIds.map((hostId) => (
              <th
                key={hostId}
                className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {hostName(hostId)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, sessionIndex) => (
            <tr
              key={sessionIndex}
              className="border-b border-border/40 last:border-b-0"
            >
              <td className="sticky left-0 z-[1] bg-background/95 px-3 py-2 align-middle text-[11px] font-medium text-foreground/80">
                #{sessionIndex + 1}
              </td>
              {hostIds.map((hostId) => {
                const chatSessionId = swarmAttemptChatSessionId(
                  runId,
                  hostId,
                  sessionIndex,
                );
                const convexSession = sessionByChatId.get(chatSessionId);
                const liveStatus =
                  stream.cellStatus[swarmCellKey(hostId, sessionIndex)];
                let outcome = resolveSwarmCellOutcome({
                  liveStatus,
                  session: convexSession,
                  runStatus,
                });
                // Unpersisted failures never appear in listSessionsByJourneyRun.
                // When the host rollup reports failures and this slot has no
                // Convex row (and isn't live-running), mark Fail so the matrix
                // matches the run summary.
                if (
                  !convexSession &&
                  (!liveStatus || liveStatus === "pending") &&
                  runStatus !== "running"
                ) {
                  const hs = hostSummaries.find((h) => h.hostId === hostId);
                  const listed = sessions.filter(
                    (s) => s.hostId === hostId,
                  ).length;
                  const unlistedFailed = hs
                    ? Math.min(hs.failed, Math.max(0, hs.total - listed))
                    : 0;
                  // Fill failed slots from the end of the session index range
                  // so succeeded rows (usually early indices) stay Done.
                  if (
                    unlistedFailed > 0 &&
                    sessionIndex >= sessionsPerHost - unlistedFailed
                  ) {
                    outcome = "failed";
                  }
                }
                const selected =
                  selection?.hostId === hostId &&
                  selection.sessionIndex === sessionIndex;
                return (
                  <td key={hostId} className="px-1.5 py-1.5 align-middle">
                    <SwarmHostCell
                      outcome={outcome}
                      goalScore={convexSession?.goalScore}
                      selected={selected}
                      onSelect={() =>
                        onSelect({ hostId, sessionIndex, chatSessionId })
                      }
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live session detail — same Trace / Chat / Raw streaming surface as
 * playground (`TraceViewModeTabs` + `TraceViewer` with `forcedViewMode`).
 */
export function SwarmLiveStreamPane({
  selection,
  stream,
  convexSession,
  fallbackTrace,
  runStatus,
  onOpenCompleted,
}: {
  selection: SwarmMatrixSelection | null;
  stream: JourneyRunStreamState;
  convexSession: JourneySessionRow | null;
  fallbackTrace: TraceEnvelope | null;
  runStatus: string;
  /** Open the full ShareUsageThreadDetail for a completed Convex session. */
  onOpenCompleted: (session: JourneySessionRow) => void;
}) {
  // Match playground default: Chat while the stream is live.
  const [viewMode, setViewMode] = useState<TraceViewMode>("chat");

  useEffect(() => {
    // Reset to Chat when the selected cell changes so each session opens on
    // the streaming-friendly view (same idea as playground turn start).
    setViewMode("chat");
  }, [selection?.chatSessionId]);

  // Completed / late-open sessions: SSE buffer is gone — load the persisted
  // transcript blob the same way ShareUsageThreadDetail does.
  const persisted = usePersistedSessionTrace(convexSession?.id ?? null);
  const displayTrace = fallbackTrace ?? persisted.trace;

  if (!selection) {
    return (
      <div
        className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 px-4 text-center text-[12px] text-muted-foreground"
        data-testid="swarm-live-pane-empty"
      >
        Select a cell to watch the live stream
      </div>
    );
  }

  const live = stream.sessions[selection.chatSessionId];
  const outcome = resolveSwarmCellOutcome({
    liveStatus: stream.cellStatus[
      swarmCellKey(selection.hostId, selection.sessionIndex)
    ],
    session: convexSession,
    runStatus,
  });
  const isTerminal =
    outcome === "succeeded" ||
    outcome === "failed" ||
    outcome === "rate_limited";
  const meta = CELL_META[outcome];
  const isStreaming = outcome === "running" || outcome === "pending";
  const showLoading = !displayTrace && (isStreaming || persisted.loading);

  return (
    <div
      className="flex min-h-0 flex-col gap-2 rounded-lg border border-border/60 bg-background/80 p-3"
      data-testid="swarm-live-pane"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold">
            Session #{selection.sessionIndex + 1}
          </p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {selection.chatSessionId}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 shrink-0">
          {isStreaming || persisted.loading ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <span className={cn("size-1.5 rounded-full", meta.dot)} />
          )}
          <span className={cn("text-[11px] font-semibold", meta.text)}>
            {meta.label}
          </span>
        </span>
      </div>

      {(live?.errorMessage || convexSession?.readiness) && (
        <p className="text-[11px] text-muted-foreground">
          {live?.errorMessage ??
            (convexSession?.readiness?.verdict
              ? `Readiness: ${convexSession.readiness.verdict}`
              : null)}
        </p>
      )}

      <div data-testid="swarm-live-trace-view-tabs">
        <TraceViewModeTabs
          layout="fullWidth"
          appearance="segment"
          mode={viewMode}
          onModeChange={(next) => {
            if (next === "tools") return;
            setViewMode(next);
          }}
          showToolsTab={false}
        />
      </div>

      {/* TraceViewer (fillContent) must be a flex child; otherwise nested
          flex-1 / min-h-0 inside TraceTimeline collapse and paint empty. */}
      <div className="flex min-h-[14rem] max-h-[min(70vh,36rem)] flex-1 flex-col overflow-hidden rounded-md border border-border/40">
        {displayTrace ? (
          <TraceViewer
            trace={displayTrace}
            toolsMetadata={{}}
            toolServerMap={{}}
            connectedServerIds={[]}
            chromeDensity="compact"
            hideToolbar
            forcedViewMode={viewMode}
            isLoading={isStreaming && !fallbackTrace}
            fillContent
          />
        ) : (
          <div className="flex h-full min-h-[14rem] items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
            {showLoading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                {isStreaming
                  ? "Stream will appear as the agent runs…"
                  : "Loading transcript…"}
              </span>
            ) : persisted.error ? (
              persisted.error
            ) : !convexSession ? (
              "No session transcript for this attempt."
            ) : (
              "No transcript for this attempt."
            )}
          </div>
        )}
      </div>

      {isTerminal && convexSession ? (
        <button
          type="button"
          className="self-start text-[11px] font-medium text-primary hover:underline"
          onClick={() => onOpenCompleted(convexSession)}
        >
          Open full session detail
        </button>
      ) : null}
    </div>
  );
}
