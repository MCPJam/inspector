import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  swarmAttemptChatSessionId,
  type JourneySessionRow,
  type SessionCriteria,
  type SessionGoalScore,
} from "@/lib/swarm-api";
import { SessionGoalScoreBadge } from "@/components/shared/session-quality/session-goal-score-badge";
import { TraceViewer } from "@/components/evals/trace-viewer";
import {
  TraceViewModeTabs,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import { hasReplayArtifacts } from "@/components/evals/browser-step-replay";
import {
  swarmCellKey,
  type JourneyRunStreamState,
  type SwarmCellLiveStatus,
} from "./use-journey-run-stream";
import { summaryTargetKey, type SwarmTargetColumn } from "./swarm-targets";
import { usePersistedSessionTrace } from "./use-persisted-session-trace";
import { shortBundleHash } from "@/components/plugins/plugin-presentation";

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

/** The execution plane's own record of one attempt (`journeyRunAttempts`). */
export type SwarmAttemptOutcome = {
  status: "pending" | "running" | "succeeded" | "failed" | "rate_limited";
  errorCode?: string | null;
  errorMessage?: string | null;
};

const TERMINAL_ATTEMPT_STATUSES = new Set([
  "succeeded",
  "failed",
  "rate_limited",
]);

export function resolveSwarmCellOutcome(args: {
  liveStatus?: SwarmCellLiveStatus;
  session?: JourneySessionRow | null;
  attempt?: SwarmAttemptOutcome | null;
  runStatus: string;
}): SwarmMatrixCellOutcome {
  const { liveStatus, session, attempt, runStatus } = args;

  // The attempt row OUTRANKS everything once terminal. It is the only record
  // of what the runner actually decided; the `chatSessions` lifecycle is a
  // different plane that says nothing about whether the attempt succeeded.
  // Without this, a rate-limited attempt whose session row sits at `active`
  // rendered as a green "done" — the run reported 20 of 20 sessions complete
  // while every one of them had been refused by the provider.
  if (attempt && TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    return attempt.status as SwarmMatrixCellOutcome;
  }

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
    if (runStatus === "running") return "running";
    // Run is over and the lifecycle never advanced. With no attempt row to
    // consult (pre-`journeyRunAttempts` runs), the transcript is the only
    // evidence left — and a session that recorded nothing did not succeed,
    // whatever the run summary counted it as.
    if ((session.messageCount ?? 0) > 0) return "succeeded";
    return runStatus === "rate_limited" ? "rate_limited" : "failed";
  }
  if (runStatus === "running") return "running";
  return "pending";
}

/**
 * One session chip: `<host> #<n> · <outcome>`. Kept `data-testid`
 * "swarm-host-cell" from the old grid so outcome assertions carry over.
 */
export function SwarmHostCell({
  hostLabel,
  sessionIndex,
  outcome,
  goalScore,
  criteria,
  selected,
  onSelect,
}: {
  hostLabel: string;
  sessionIndex: number;
  outcome: SwarmMatrixCellOutcome;
  goalScore?: SessionGoalScore;
  criteria?: SessionCriteria;
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
      aria-label={`Open session ${sessionIndex + 1} on ${hostLabel} (${
        meta.label
      })`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5"
          : "border-border/50 bg-background/60"
      )}
    >
      <span className="font-medium text-foreground/80">{hostLabel}</span>
      <span className="font-mono text-[10px] text-muted-foreground">
        #{sessionIndex + 1}
      </span>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      <span className={cn("font-semibold", meta.text)}>{meta.label}</span>
      <SessionGoalScoreBadge goalScore={goalScore} />
      <SessionCriteriaChip criteria={criteria} />
    </button>
  );
}

/**
 * Per-cell deterministic rubric verdict: `N/M` passed when graded, a subtle
 * glyph while pending or after a grading failure, and NOTHING when the session
 * carries no stamp.
 *
 * Rendering nothing for an absent stamp is the point. A `0/0` would claim the
 * session was graded against an empty rubric; absence means the run had no
 * rubric at all, which is a different thing and belongs in no denominator.
 */
function SessionCriteriaChip({ criteria }: { criteria?: SessionCriteria }) {
  if (!criteria) return null;

  if (criteria.status === "completed") {
    const results = criteria.results ?? [];
    if (results.length === 0) return null;
    const passed = results.filter((r) => r.passed).length;
    const allPassed = passed === results.length;
    return (
      <span
        title={`${passed} of ${results.length} checks passed`}
        className={cn(
          "rounded px-1 font-mono text-[10px] tabular-nums",
          allPassed
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-destructive/10 text-destructive"
        )}
      >
        {passed}/{results.length}
      </span>
    );
  }

  // Pending and failed-grading stay visually quiet — they say something about
  // the GRADER, not about the session, and shouting them would read as a
  // product failure.
  const pending = criteria.status === "pending";
  return (
    <span
      title={
        pending ? "Checks still being graded" : "Checks could not be graded"
      }
      className="rounded px-1 font-mono text-[10px] text-muted-foreground"
    >
      {pending ? "…" : "—"}
    </span>
  );
}

export type SwarmMatrixSelection = {
  /** Canonical target key (`targetId ?? hostId` — D2). */
  targetKey: string;
  hostId: string;
  sessionIndex: number;
  chatSessionId: string;
};

export function SwarmSessionsMatrix({
  runId,
  targets,
  sessionsPerTarget,
  sessions,
  hostSummaries,
  stream,
  runStatus,
  selection,
  onSelect,
  targetKeyFilter,
}: {
  runId: string;
  /** One column per execution target (per-target model — B6). */
  targets: SwarmTargetColumn[];
  sessionsPerTarget: number;
  sessions: JourneySessionRow[];
  hostSummaries: Array<{
    hostId: string;
    targetId?: string;
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  }>;
  stream: JourneyRunStreamState;
  runStatus: string;
  selection: SwarmMatrixSelection | null;
  onSelect: (sel: SwarmMatrixSelection) => void;
  /** When set, only render session chips for this target. */
  targetKeyFilter?: string;
}) {
  const sessionByChatId = useMemo(() => {
    const map = new Map<string, JourneySessionRow>();
    for (const s of sessions) {
      map.set(s.chatSessionId, s);
    }
    return map;
  }, [sessions]);

  const rows = Math.max(1, sessionsPerTarget);
  const visibleTargets = targetKeyFilter
    ? targets.filter((target) => target.key === targetKeyFilter)
    : targets;

  return (
    <div className="min-w-0" data-testid="swarm-sessions-matrix">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Sessions
      </p>
      <div className="flex flex-wrap gap-1.5">
        {visibleTargets.flatMap((target) => {
          // Per-TARGET minted cell ids (shared mint — env targets key on the
          // environmentId identity, so two same-host targets never collide).
          const cellIds = Array.from({ length: rows }, (_, sessionIndex) =>
            swarmAttemptChatSessionId(runId, target.identity, sessionIndex)
          );
          const listed = cellIds.filter((id) => sessionByChatId.has(id)).length;
          return cellIds.map((chatSessionId, sessionIndex) => {
            const convexSession = sessionByChatId.get(chatSessionId);
            const liveStatus =
              stream.cellStatus[swarmCellKey(target.key, sessionIndex)];
            let outcome = resolveSwarmCellOutcome({
              liveStatus,
              session: convexSession,
              runStatus,
            });
            // Unpersisted failures never appear in listSessionsByJourneyRun.
            // When the target rollup reports failures and this slot has no
            // Convex row (and isn't live-running), mark Fail so the chips
            // match the run summary.
            if (
              !convexSession &&
              (!liveStatus || liveStatus === "pending") &&
              runStatus !== "running"
            ) {
              const hs = hostSummaries.find(
                (h) => summaryTargetKey(h) === target.key
              );
              const unlistedFailed = hs
                ? Math.min(hs.failed, Math.max(0, hs.total - listed))
                : 0;
              // Fill failed slots from the end of the session index range so
              // succeeded slots (usually early indices) stay Done.
              if (
                unlistedFailed > 0 &&
                sessionIndex >= sessionsPerTarget - unlistedFailed
              ) {
                outcome = "failed";
              }
            }
            const selected =
              selection?.targetKey === target.key &&
              selection.sessionIndex === sessionIndex;
            return (
              <SwarmHostCell
                key={`${target.key}:${sessionIndex}`}
                hostLabel={target.label}
                sessionIndex={sessionIndex}
                outcome={outcome}
                goalScore={convexSession?.goalScore}
                criteria={convexSession?.criteria}
                selected={selected}
                onSelect={() =>
                  onSelect({
                    targetKey: target.key,
                    hostId: target.hostId,
                    sessionIndex,
                    chatSessionId,
                  })
                }
              />
            );
          });
        })}
      </div>
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
  fillHeight = false,
  autoFollowing = false,
}: {
  selection: SwarmMatrixSelection | null;
  stream: JourneyRunStreamState;
  convexSession: JourneySessionRow | null;
  fallbackTrace: TraceEnvelope | null;
  runStatus: string;
  /** Open the full ShareUsageThreadDetail for a completed Convex session. */
  onOpenCompleted: (session: JourneySessionRow) => void;
  /** Fill the parent's height instead of capping the trace viewport. */
  fillHeight?: boolean;
  /**
   * True while the pane is following the run rather than a session the viewer
   * chose. Worth saying out loud: it explains why the view moves on its own, and
   * that clicking a session stops it.
   */
  autoFollowing?: boolean;
}) {
  // Match playground default: Chat while the stream is live.
  const [viewMode, setViewMode] = useState<TraceViewMode>("chat");
  // The Replay tab's mode lives outside the shared `TraceViewMode` union (see
  // trace-view-mode-tabs.tsx), so it rides its own flag.
  const [replayActive, setReplayActive] = useState(false);

  useEffect(() => {
    // Reset to Chat when the selected cell changes so each session opens on
    // the streaming-friendly view (same idea as playground turn start).
    setViewMode("chat");
    setReplayActive(false);
  }, [selection?.chatSessionId]);

  // Completed / late-open sessions: SSE buffer is gone — load the persisted
  // transcript blob the same way ShareUsageThreadDetail does.
  const persisted = usePersistedSessionTrace(convexSession?.id ?? null);

  // The live SSE trace wins for the transcript — it is ahead of the persisted
  // blob while the run is going. But its browser artifacts are only the LIVE
  // frames: no video (there is none until the run ends) and no render
  // observations. The persisted query is where the final ones arrive, and it
  // keeps polling after the run finishes, so overlay them on top of the fallback
  // rather than letting a lingering live trace hide the finished recording.
  const displayTrace: TraceEnvelope | null = useMemo(() => {
    if (!fallbackTrace) return persisted.trace;
    const finalized = persisted.trace;
    if (!finalized) return fallbackTrace;
    return {
      ...fallbackTrace,
      ...(finalized.widgetRenderObservations?.length
        ? { widgetRenderObservations: finalized.widgetRenderObservations }
        : {}),
      // Persisted steps supersede the live frames once they exist: same steps,
      // full-resolution screenshots, and a `videoOffsetMs` to seek with.
      ...(finalized.browserInteractionSteps?.length
        ? { browserInteractionSteps: finalized.browserInteractionSteps }
        : {}),
      ...(finalized.videoUrl ? { videoUrl: finalized.videoUrl } : {}),
    };
  }, [fallbackTrace, persisted.trace]);

  // Replay availability — the SHARED predicate, so this pane's tab and the
  // viewer's panel can't disagree about (say) an empty-string videoUrl.
  // `replayActive` is component state that survives a cell switch, so clamp it
  // rather than resetting: flipping back restores the view.
  const hasReplay = hasReplayArtifacts(displayTrace ?? {});
  const showReplay = replayActive && hasReplay;

  if (!selection) {
    return (
      <div
        className={cn(
          "flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 px-4 text-center text-[12px] text-muted-foreground",
          fillHeight && "h-full"
        )}
        data-testid="swarm-live-pane-empty"
      >
        Select a cell to watch the live stream
      </div>
    );
  }

  const live = stream.sessions[selection.chatSessionId];
  const outcome = resolveSwarmCellOutcome({
    liveStatus:
      stream.cellStatus[
        swarmCellKey(selection.targetKey, selection.sessionIndex)
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
      className={cn(
        "flex min-h-0 flex-col gap-2 rounded-lg border border-border/60 bg-background/80 p-3",
        fillHeight && "h-full flex-1"
      )}
      data-testid="swarm-live-pane"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold">
            Session #{selection.sessionIndex + 1}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 shrink-0">
          {autoFollowing ? (
            <span
              className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="Following the run — pick a session to stay on it"
              data-testid="swarm-live-pane-following"
            >
              Following
            </span>
          ) : null}
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

      {live?.errorMessage ? (
        <p className="text-[11px] text-muted-foreground">{live.errorMessage}</p>
      ) : null}

      {/* Setup notes for this session — e.g. a host built-in that was
          deliberately not advertised. Shown as its own line, not folded into
          the error slot: the session is healthy, it just ran with less than the
          host config asked for, and a silently absent tool reads as a bug. */}
      {live?.notices?.length ? (
        <ul
          className="flex flex-col gap-1"
          data-testid="swarm-live-pane-notices"
        >
          {live.notices.map((notice, i) => (
            <li
              key={`${notice.kind}:${notice.toolId ?? ""}:${i}`}
              className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
            >
              <Info className="mt-[1px] size-3 shrink-0" aria-hidden />
              <span className="min-w-0">{notice.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Which plugin bundle produced this transcript. A swarm transcript is
          the only record of what a simulated session ran with, and a plugin
          re-import silently changed the answer until the run snapshot started
          carrying it. Read-only provenance, not a restorable pin — and shown
          only when the target pinned one. */}
      {persisted.pluginVersions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Plugins
          </span>
          {persisted.pluginVersions.map((version) => (
            <span
              key={version.pluginVersionId}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px]"
              title={`Plugin version ${version.pluginVersionId} · bundle ${version.bundleHash}`}
            >
              <span className="text-foreground">{version.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {shortBundleHash(version.bundleHash)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div data-testid="swarm-live-trace-view-tabs">
        <TraceViewModeTabs
          layout="fullWidth"
          appearance="segment"
          mode={viewMode}
          onModeChange={(next) => {
            if (next === "tools") return;
            setReplayActive(false);
            setViewMode(next);
          }}
          showToolsTab={false}
          // Swarms are the one surface that runs Computer Use, so they produce
          // the richest recording — the Replay tab is where you watch it back.
          showBrowserTab={hasReplay}
          browserActive={showReplay}
          onSelectBrowser={() => setReplayActive(true)}
        />
      </div>

      {/* A timeline the viewer SYNTHESIZED from `estimatedDurationMs`, shown
          without a word, is BB-153 over again — so say so next to it. The
          no-trace branch below cannot carry this: the transcript loading fine
          while its span blobs fail is exactly the case, and it renders the
          viewer. */}
      {displayTrace && persisted.spanError ? (
        <div
          className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400"
          data-testid="swarm-live-pane-span-error"
        >
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          {persisted.spanError} — durations below are estimated.
        </div>
      ) : null}

      {/* TraceViewer (fillContent) must be a flex child; otherwise nested
          flex-1 / min-h-0 inside TraceTimeline collapse and paint empty. */}
      <div
        className={cn(
          "flex min-h-[14rem] flex-1 flex-col overflow-hidden rounded-md border border-border/40",
          !fillHeight && "max-h-[min(70vh,36rem)]"
        )}
      >
        {displayTrace ? (
          <TraceViewer
            trace={displayTrace}
            toolsMetadata={{}}
            toolServerMap={{}}
            connectedServerIds={[]}
            chromeDensity="compact"
            hideToolbar
            forcedViewMode={showReplay ? "browser" : viewMode}
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
            ) : (persisted.error ?? persisted.spanError) ? (
              (persisted.error ?? persisted.spanError)
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
